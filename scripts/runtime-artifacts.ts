import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export interface ArtifactRecipe {
  id: string;
  inputs: string[];
  outputs: string[];
  requiredOutputs: string[];
  excludeInputs?: string[];
  excludeOutputs?: string[];
  toolchain: Record<string, string>;
  commands: string[][];
}

interface FileDigest {
  path: string;
  sha256: string;
  executable: boolean;
}

interface BuildReceipt {
  schemaVersion: 1;
  inputDigest: string;
  outputs: FileDigest[];
}

const ignoredDirectories = new Set(['node_modules', '.git', '.cache']);
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function snapshot(root: string, roots: string[], exclusions: string[] = []): FileDigest[] {
  const result = new Map<string, FileDigest>();
  const visit = (relative: string) => {
    relative = relative.split(path.sep).join('/');
    if (exclusions.some((excluded) => relative === excluded || relative.startsWith(`${excluded}/`))) {
      return;
    }
    const absolute = path.join(root, relative);
    if (!existsSync(absolute)) {
      return;
    }
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      // 同时计算链接和目标的摘要，切换源码链接时不能继续沿用
      // 旧凭据；目录链接可能造成循环遍历，因此禁止作为输入。
      const target = path.resolve(path.dirname(absolute), readlinkSync(absolute));
      if (!lstatSync(target).isFile()) {
        throw new Error(`Runtime artifact inputs must not contain directory symlinks: ${relative}`);
      }
      result.set(relative, {
        path: relative,
        sha256: digest(`${readlinkSync(absolute)}\0${digest(readFileSync(target))}`),
        executable: Boolean(lstatSync(target).mode & 0o111),
      });
    } else if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) {
        if (!ignoredDirectories.has(name) && !name.endsWith('.tsbuildinfo')) {
          visit(path.join(relative, name));
        }
      }
    } else if (stat.isFile()) {
      result.set(relative, {
        path: relative,
        sha256: digest(readFileSync(absolute)),
        executable: Boolean(stat.mode & 0o111),
      });
    }
  };
  roots.forEach(visit);
  return [...result.values()].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

function inputDigest(root: string, recipe: ArtifactRecipe): string {
  return digest(
    JSON.stringify({
      workspaceRoot: path.resolve(root),
      recipe,
      files: snapshot(root, recipe.inputs, recipe.excludeInputs),
    }),
  );
}

function receiptPath(root: string, recipe: ArtifactRecipe): string {
  return path.join(root, '.cache/runtime-artifacts', `${recipe.id}.json`);
}

function readReceipt(root: string, recipe: ArtifactRecipe): BuildReceipt | undefined {
  try {
    const receipt = JSON.parse(readFileSync(receiptPath(root, recipe), 'utf8')) as BuildReceipt;
    return receipt.schemaVersion === 1 && Array.isArray(receipt.outputs) ? receipt : undefined;
  } catch {
    return undefined;
  }
}

function missingOutputs(root: string, recipe: ArtifactRecipe): string[] {
  return recipe.requiredOutputs.filter((file) => {
    const absolute = path.join(root, file);
    return !existsSync(absolute) || !lstatSync(absolute).isFile() || lstatSync(absolute).size === 0;
  });
}

export function inspectArtifacts(root: string, recipe: ArtifactRecipe): { fresh: boolean; reason: string } {
  const receipt = readReceipt(root, recipe);
  if (!receipt) {
    return { fresh: false, reason: 'no completed build receipt' };
  }
  if (receipt.inputDigest !== inputDigest(root, recipe)) {
    return { fresh: false, reason: 'sources, configuration, dependencies or toolchain changed' };
  }
  const missing = missingOutputs(root, recipe);
  if (missing.length) {
    return { fresh: false, reason: `missing outputs: ${missing.join(', ')}` };
  }
  if (JSON.stringify(receipt.outputs) !== JSON.stringify(snapshot(root, recipe.outputs, recipe.excludeOutputs))) {
    return { fresh: false, reason: 'build outputs were changed, added or removed' };
  }
  return { fresh: true, reason: 'input and output hashes match' };
}

/* * 构建失败或构建期间源码变化时，不得发布有效产物凭据。 */
export async function buildArtifacts(
  root: string,
  recipe: ArtifactRecipe,
  build: (commands: string[][]) => Promise<void>,
): Promise<void> {
  const before = inputDigest(root, recipe);
  const destination = receiptPath(root, recipe);
  rmSync(destination, { force: true });
  await build(recipe.commands);
  if (inputDigest(root, recipe) !== before) {
    throw new Error(`${recipe.id}: inputs changed during the build; run the build again`);
  }
  const missing = missingOutputs(root, recipe);
  if (missing.length) {
    throw new Error(`${recipe.id}: build completed without required outputs: ${missing.join(', ')}`);
  }
  const receipt: BuildReceipt = {
    schemaVersion: 1,
    inputDigest: before,
    outputs: snapshot(root, recipe.outputs, recipe.excludeOutputs),
  };
  mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`);
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}
