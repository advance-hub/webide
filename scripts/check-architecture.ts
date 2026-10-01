import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript-api';

const SOURCE_EXTENSIONS = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx']);
const IGNORED_DIRECTORIES = new Set([
  '__mocks__',
  '__test__',
  '__tests__',
  'coverage',
  'dist',
  'dist-node',
  'fixtures',
  'lib',
  'node_modules',
]);
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;
const RUNTIME_DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const;
const RUNTIME_ROOT_PACKAGES = new Set([
  '@opensumi/ide-core-browser',
  '@opensumi/ide-core-electron-main',
  '@opensumi/ide-core-node',
]);
const RUNTIME_FACETS = new Set([
  'browser',
  'browser-worker',
  'electron',
  'electron-main',
  'extension-host',
  'hosted',
  'node',
  'worker',
]);
export const ARCHITECTURE_BASELINE_PATH = 'scripts/architecture-baseline.json';

export interface CountBaseline {
  commonFacetImports: Record<string, number>;
  /** Runtime-reaching package-root import sites, grouped by source -> target package. */
  commonRuntimeRootImports: Record<string, number>;
  deepImportsByPackage: Record<string, number>;
  /** Runtime value imports whose workspace dependency is declared only for development. */
  runtimeImportsFromDevDependencies: Record<string, number>;
  undeclaredWorkspaceDependencies: Record<string, number>;
}

const COUNT_BASELINE_FIELDS = [
  'commonFacetImports',
  'commonRuntimeRootImports',
  'deepImportsByPackage',
  'runtimeImportsFromDevDependencies',
  'undeclaredWorkspaceDependencies',
] as const satisfies readonly (keyof CountBaseline)[];
const HISTORICALLY_OPTIONAL_BASELINE_FIELDS = new Set<keyof CountBaseline>([
  'commonRuntimeRootImports',
  'runtimeImportsFromDevDependencies',
]);

export interface WorkspacePackage {
  dependencies: Set<string>;
  exports?: Record<string, unknown>;
  name: string;
  root: string;
  runtimeDependencies: Set<string>;
}

export interface ImportRecord {
  file: string;
  line: number;
  sourcePackage: string;
  specifier: string;
  targetPackage?: string;
  typeOnly: boolean;
}

export interface ArchitectureSnapshot {
  commonFacetImports: Map<string, number>;
  commonRuntimeRootImports: Map<string, number>;
  cycles: string[][];
  deepImportsByPackage: Map<string, number>;
  edges: Array<[string, string]>;
  imports: ImportRecord[];
  packages: WorkspacePackage[];
  runtimeImportsFromDevDependencies: Map<string, number>;
  undeclaredWorkspaceDependencies: Map<string, number>;
}

export interface ArchitectureProblem {
  kind:
    | 'baseline-regression'
    | 'common-facet-import'
    | 'common-runtime-root-import'
    | 'dependency-cycle'
    | 'deep-import'
    | 'private-package-import'
    | 'runtime-import-from-dev-dependency'
    | 'undeclared-workspace-dependency';
  message: string;
}

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  exports?: Record<string, unknown>;
  name?: string;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  workspaces?: string[];
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) || 0) + 1);
}

function toSortedRecord(counts: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

function parseWorkspaceScalar(value: string): string {
  const withoutComment = value.replace(/\s+#.*$/, '').trim();
  if (
    (withoutComment.startsWith("'") && withoutComment.endsWith("'")) ||
    (withoutComment.startsWith('"') && withoutComment.endsWith('"'))
  ) {
    return withoutComment.slice(1, -1);
  }
  return withoutComment;
}

export function parsePnpmWorkspacePatterns(source: string): string[] {
  const patterns: string[] = [];
  let inPackages = false;
  for (const line of source.split(/\r?\n/)) {
    if (!inPackages) {
      if (/^packages:\s*(?:#.*)?$/.test(line)) {
        inPackages = true;
      }
      continue;
    }
    if (/^\S/.test(line)) {
      break;
    }
    const match = /^\s+-\s+(.+?)\s*$/.exec(line);
    if (match) {
      const pattern = parseWorkspaceScalar(match[1]);
      if (!pattern) {
        throw new Error('pnpm-workspace.yaml contains an empty package pattern');
      }
      patterns.push(pattern);
    } else if (line.trim() && !line.trimStart().startsWith('#')) {
      throw new Error(`Unsupported pnpm workspace package entry: ${line.trim()}`);
    }
  }
  if (!inPackages || patterns.length === 0) {
    throw new Error('pnpm-workspace.yaml must declare a non-empty packages list');
  }
  return patterns;
}

function collectWorkspaceRoots(repoRoot: string, patterns: string[]): string[] {
  const roots = new Set<string>();
  for (const pattern of patterns) {
    if (!pattern.includes('*')) {
      roots.add(path.join(repoRoot, pattern));
      continue;
    }
    if (!pattern.endsWith('/*') || pattern.slice(0, -2).includes('*')) {
      throw new Error(`Unsupported workspace pattern: ${pattern}`);
    }
    const parent = path.join(repoRoot, pattern.slice(0, -2));
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        roots.add(path.join(parent, entry.name));
      }
    }
  }
  return [...roots].filter((root) => fs.existsSync(path.join(root, 'package.json'))).sort();
}

export function discoverWorkspacePackages(repoRoot: string): WorkspacePackage[] {
  const rootManifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as PackageManifest;
  const workspacePatterns = parsePnpmWorkspacePatterns(
    fs.readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8'),
  );
  const rootPatterns = rootManifest.workspaces || [];
  if (JSON.stringify([...workspacePatterns].sort()) !== JSON.stringify([...rootPatterns].sort())) {
    throw new Error('package.json workspaces must match pnpm-workspace.yaml packages');
  }
  const roots = collectWorkspaceRoots(repoRoot, workspacePatterns);
  return roots.map((root) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as PackageManifest;
    if (!manifest.name) {
      throw new Error(`Workspace package has no name: ${path.relative(repoRoot, root)}`);
    }
    const dependencies = new Set<string>();
    const runtimeDependencies = new Set<string>();
    for (const field of DEPENDENCY_FIELDS) {
      for (const name of Object.keys(manifest[field] || {})) {
        dependencies.add(name);
      }
    }
    for (const field of RUNTIME_DEPENDENCY_FIELDS) {
      for (const name of Object.keys(manifest[field] || {})) {
        runtimeDependencies.add(name);
      }
    }
    return { dependencies, exports: manifest.exports, name: manifest.name, root, runtimeDependencies };
  });
}

function walkSourceFiles(directory: string, files: string[]): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) {
      continue;
    }
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walkSourceFiles(absolutePath, files);
    } else if (
      SOURCE_EXTENSIONS.has(path.extname(entry.name)) &&
      !entry.name.endsWith('.d.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.test.tsx') &&
      !entry.name.endsWith('.spec.ts') &&
      !entry.name.endsWith('.spec.tsx')
    ) {
      files.push(absolutePath);
    }
  }
}

export function extractModuleSpecifiers(
  sourceText: string,
  fileName = 'source.ts',
): Array<{ line: number; specifier: string; typeOnly: boolean }> {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const result: Array<{ line: number; specifier: string; typeOnly: boolean }> = [];
  const add = (literal: ts.Expression, typeOnly: boolean): void => {
    if (ts.isStringLiteralLike(literal)) {
      result.push({
        line: sourceFile.getLineAndCharacterOfPosition(literal.getStart(sourceFile)).line + 1,
        specifier: literal.text,
        typeOnly,
      });
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const bindings = node.importClause?.namedBindings;
      const typeOnly = Boolean(
        node.importClause?.isTypeOnly ||
        (bindings &&
          ts.isNamedImports(bindings) &&
          !node.importClause?.name &&
          bindings.elements.length > 0 &&
          bindings.elements.every((element) => element.isTypeOnly)),
      );
      add(node.moduleSpecifier, typeOnly);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const typeOnly = Boolean(
        node.isTypeOnly ||
        (node.exportClause &&
          ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.length > 0 &&
          node.exportClause.elements.every((element) => element.isTypeOnly)),
      );
      add(node.moduleSpecifier, typeOnly);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node.argument.literal, true);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      if (node.moduleReference.expression) {
        add(node.moduleReference.expression, node.isTypeOnly);
      }
    } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const isRequireResolve =
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'require' &&
        node.expression.name.text === 'resolve';
      if (isDynamicImport || isRequire || isRequireResolve) {
        add(node.arguments[0], false);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return result;
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function targetPackageForSpecifier(
  file: string,
  specifier: string,
  packages: WorkspacePackage[],
  packageNames: string[],
): WorkspacePackage | undefined {
  const packageName = packageNames.find((name) => specifier === name || specifier.startsWith(`${name}/`));
  if (packageName) {
    return packages.find(({ name }) => name === packageName);
  }
  if (!specifier.startsWith('.')) {
    return undefined;
  }
  const resolved = path.resolve(path.dirname(file), specifier);
  return [...packages]
    .sort((left, right) => right.root.length - left.root.length)
    .find(({ root }) => isPathInside(root, resolved));
}

function sourceFacet(file: string): string | undefined {
  const segments = path.resolve(file).split(path.sep);
  const sourceIndex = Math.max(segments.lastIndexOf('src'), segments.lastIndexOf('entry'));
  return sourceIndex >= 0 ? segments[sourceIndex + 1] : undefined;
}

export function isRuntimeFacetSpecifier(file: string, specifier: string, targetPackage?: string): boolean {
  if (specifier.startsWith('.')) {
    return RUNTIME_FACETS.has(sourceFacet(path.resolve(path.dirname(file), specifier)) || '');
  }
  if (targetPackage && RUNTIME_ROOT_PACKAGES.has(targetPackage)) {
    return true;
  }
  if (targetPackage) {
    const suffix = path.posix.normalize(specifier.slice(targetPackage.length));
    return new RegExp(`^/(?:lib/|src/)?(?:${[...RUNTIME_FACETS].join('|')})(?:/|$)`).test(suffix);
  }
  return false;
}

export function isDirectCommonFacetImport(file: string, specifier: string, targetPackage?: string): boolean {
  if (sourceFacet(file) !== 'common') {
    return false;
  }
  return isRuntimeFacetSpecifier(file, specifier, targetPackage);
}

function resolveRelativeSourceModule(file: string, specifier: string, packageRoot: string): string | undefined {
  if (!specifier.startsWith('.')) {
    return undefined;
  }
  const unresolved = path.resolve(path.dirname(file), specifier);
  const candidates = [
    unresolved,
    ...[...SOURCE_EXTENSIONS].map((extension) => `${unresolved}${extension}`),
    ...[...SOURCE_EXTENSIONS].map((extension) => path.join(unresolved, `index${extension}`)),
  ];
  return candidates.find(
    (candidate) =>
      isPathInside(packageRoot, candidate) &&
      fs.existsSync(candidate) &&
      fs.statSync(candidate).isFile() &&
      !candidate.endsWith('.d.ts'),
  );
}

/**
 * Finds workspace package roots whose public `src/index` entrypoint can reach
 * a runtime facet. The traversal intentionally follows every static or dynamic
 * import/re-export in the package-local relative closure, not only named public
 * exports: importing the root can execute those modules or expose their types.
 * Exact workspace-root dependencies are propagated to a fixed point so a root
 * cannot hide a runtime-specific root behind another package root.
 */
export function findRuntimeRootPackages(packages: WorkspacePackage[]): Set<string> {
  const packageNames = packages.map(({ name }) => name).sort((left, right) => right.length - left.length);
  const summaries = new Map<string, { directRuntime: boolean; rootDependencies: Set<string> }>();

  for (const workspacePackage of packages) {
    const syntheticEntrypoint = path.join(workspacePackage.root, 'src', 'entrypoint');
    const entrypoint = resolveRelativeSourceModule(syntheticEntrypoint, './index', workspacePackage.root);
    const summary = {
      directRuntime: RUNTIME_ROOT_PACKAGES.has(workspacePackage.name),
      rootDependencies: new Set<string>(),
    };
    summaries.set(workspacePackage.name, summary);
    if (!entrypoint) {
      continue;
    }

    const pending = [entrypoint];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (visited.has(file)) {
        continue;
      }
      visited.add(file);
      for (const extracted of extractModuleSpecifiers(fs.readFileSync(file, 'utf8'), file)) {
        const targetPackage = targetPackageForSpecifier(file, extracted.specifier, packages, packageNames);
        if (isRuntimeFacetSpecifier(file, extracted.specifier, targetPackage?.name)) {
          summary.directRuntime = true;
        }
        const relativeTarget = resolveRelativeSourceModule(file, extracted.specifier, workspacePackage.root);
        if (relativeTarget) {
          pending.push(relativeTarget);
        } else if (targetPackage && extracted.specifier === targetPackage.name) {
          summary.rootDependencies.add(targetPackage.name);
        }
      }
    }
  }

  const runtimeRoots = new Set(
    [...summaries].filter(([, summary]) => summary.directRuntime).map(([packageName]) => packageName),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const [packageName, summary] of summaries) {
      if (!runtimeRoots.has(packageName) && [...summary.rootDependencies].some((name) => runtimeRoots.has(name))) {
        runtimeRoots.add(packageName);
        changed = true;
      }
    }
  }
  return runtimeRoots;
}

function findStronglyConnectedComponents(graph: Map<string, Set<string>>): string[][] {
  let nextIndex = 0;
  const indexByNode = new Map<string, number>();
  const lowLinkByNode = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  const connect = (node: string): void => {
    indexByNode.set(node, nextIndex);
    lowLinkByNode.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);
    for (const target of graph.get(node) || []) {
      if (!indexByNode.has(target)) {
        connect(target);
        lowLinkByNode.set(node, Math.min(lowLinkByNode.get(node)!, lowLinkByNode.get(target)!));
      } else if (onStack.has(target)) {
        lowLinkByNode.set(node, Math.min(lowLinkByNode.get(node)!, indexByNode.get(target)!));
      }
    }
    if (lowLinkByNode.get(node) === indexByNode.get(node)) {
      const component: string[] = [];
      let current: string;
      do {
        current = stack.pop()!;
        onStack.delete(current);
        component.push(current);
      } while (current !== node);
      components.push(component.sort());
    }
  };

  for (const node of [...graph.keys()].sort()) {
    if (!indexByNode.has(node)) {
      connect(node);
    }
  }
  return components;
}

export function findDependencyCycles(graph: Map<string, Set<string>>): string[][] {
  return findStronglyConnectedComponents(graph).filter(
    (component) => component.length > 1 || (graph.get(component[0]) || new Set()).has(component[0]),
  );
}

export function createWorkspaceDependencyGraph(packages: WorkspacePackage[]): Map<string, Set<string>> {
  const workspaceNames = new Set(packages.map(({ name }) => name));
  return new Map(
    packages.map(({ name, runtimeDependencies }) => [
      name,
      new Set([...runtimeDependencies].filter((dependency) => workspaceNames.has(dependency))),
    ]),
  );
}

export function analyzeArchitecture(repoRoot: string): ArchitectureSnapshot {
  const packages = discoverWorkspacePackages(repoRoot);
  const packageNames = packages.map(({ name }) => name).sort((left, right) => right.length - left.length);
  const runtimeRootPackages = findRuntimeRootPackages(packages);
  // Package manifests are the declared runtime graph. Source imports are then merged in so
  // undeclared-but-real dependencies cannot hide a cycle from the gate.
  const graph = createWorkspaceDependencyGraph(packages);
  const imports: ImportRecord[] = [];
  const commonFacetImports = new Map<string, number>();
  const commonRuntimeRootImports = new Map<string, number>();
  const deepImportsByPackage = new Map<string, number>();
  const runtimeImportsFromDevDependencies = new Map<string, number>();
  const undeclaredWorkspaceDependencies = new Map<string, number>();

  for (const workspacePackage of packages) {
    const files: string[] = [];
    for (const sourceDirectory of ['src', 'entry']) {
      const directory = path.join(workspacePackage.root, sourceDirectory);
      if (fs.existsSync(directory)) {
        walkSourceFiles(directory, files);
      }
    }
    for (const file of files.sort()) {
      const relativeFile = path.relative(repoRoot, file).split(path.sep).join('/');
      for (const extracted of extractModuleSpecifiers(fs.readFileSync(file, 'utf8'), file)) {
        const targetPackage = targetPackageForSpecifier(file, extracted.specifier, packages, packageNames);
        const record: ImportRecord = {
          ...extracted,
          file: relativeFile,
          sourcePackage: workspacePackage.name,
          targetPackage: targetPackage?.name,
        };
        imports.push(record);
        if (targetPackage && targetPackage.name !== workspacePackage.name) {
          if (!extracted.typeOnly) {
            graph.get(workspacePackage.name)!.add(targetPackage.name);
          }
          if (!workspacePackage.dependencies.has(targetPackage.name)) {
            increment(undeclaredWorkspaceDependencies, `${workspacePackage.name} -> ${targetPackage.name}`);
          } else if (!extracted.typeOnly && !workspacePackage.runtimeDependencies.has(targetPackage.name)) {
            // A source value import ships in the package runtime. Preserve the
            // pre-existing dev-only debt as a separate exact baseline so it
            // can only shrink without redefining the older undeclared metric.
            increment(runtimeImportsFromDevDependencies, `${workspacePackage.name} -> ${targetPackage.name}`);
          }
        }
        if (
          targetPackage &&
          ((targetPackage.name !== workspacePackage.name && extracted.specifier.startsWith('.')) ||
            extracted.specifier === `${targetPackage.name}/lib` ||
            extracted.specifier === `${targetPackage.name}/src` ||
            extracted.specifier.startsWith(`${targetPackage.name}/lib/`) ||
            extracted.specifier.startsWith(`${targetPackage.name}/src/`))
        ) {
          increment(deepImportsByPackage, workspacePackage.name);
        }
        if (isDirectCommonFacetImport(file, extracted.specifier, targetPackage?.name)) {
          increment(commonFacetImports, `${relativeFile} -> ${extracted.specifier}`);
        }
        if (
          sourceFacet(file) === 'common' &&
          targetPackage &&
          extracted.specifier === targetPackage.name &&
          runtimeRootPackages.has(targetPackage.name)
        ) {
          increment(commonRuntimeRootImports, `${workspacePackage.name} -> ${targetPackage.name}`);
        }
      }
    }
  }

  const edges = [...graph]
    .flatMap(([source, targets]) => [...targets].map((target): [string, string] => [source, target]))
    .sort(([leftSource, leftTarget], [rightSource, rightTarget]) =>
      `${leftSource}\0${leftTarget}`.localeCompare(`${rightSource}\0${rightTarget}`),
    );
  return {
    commonFacetImports,
    commonRuntimeRootImports,
    cycles: findDependencyCycles(graph),
    deepImportsByPackage,
    edges,
    imports,
    packages,
    runtimeImportsFromDevDependencies,
    undeclaredWorkspaceDependencies,
  };
}

function compareExactCounts(
  current: Map<string, number>,
  baseline: Record<string, number>,
  kind: ArchitectureProblem['kind'],
  description: string,
): ArchitectureProblem[] {
  const problems: ArchitectureProblem[] = [];
  const keys = new Set([...current.keys(), ...Object.keys(baseline)]);
  for (const key of [...keys].sort()) {
    const count = current.get(key) || 0;
    const expected = baseline[key] || 0;
    if (count !== expected) {
      problems.push({ kind, message: `${description}: ${key} (current ${count}, branch baseline ${expected})` });
    }
  }
  return problems;
}

export function evaluateBaselineHistory(branch: CountBaseline, base: CountBaseline): ArchitectureProblem[] {
  const problems: ArchitectureProblem[] = [];
  for (const field of COUNT_BASELINE_FIELDS) {
    const keys = new Set([...Object.keys(branch[field]), ...Object.keys(base[field])]);
    for (const key of [...keys].sort()) {
      const branchCount = branch[field][key] || 0;
      const baseCount = base[field][key] || 0;
      if (branchCount > baseCount) {
        problems.push({
          kind: 'baseline-regression',
          message: `${field}: ${key} (branch ${branchCount}, base ${baseCount})`,
        });
      }
    }
  }
  return problems;
}

/** Explicit package contracts cannot be bypassed by renaming a private import. */
export function evaluatePackageImports(
  snapshot: Pick<ArchitectureSnapshot, 'imports' | 'packages'>,
): ArchitectureProblem[] {
  const packages = new Map(snapshot.packages.map((entry) => [entry.name, entry]));
  const problems: ArchitectureProblem[] = [];
  for (const imported of snapshot.imports) {
    const target = imported.targetPackage && packages.get(imported.targetPackage);
    if (!target || !target.exports || imported.specifier.startsWith('.')) {
      continue;
    }
    const subpath = `.${imported.specifier.slice(target.name.length)}`;
    if (!Object.hasOwn(target.exports, subpath) || target.exports[subpath] === null) {
      problems.push({
        kind: 'private-package-import',
        message: `${imported.file}:${imported.line} imports ${imported.specifier}, which is outside ${target.name}'s explicit exports`,
      });
    }
  }
  return problems;
}

export function evaluateArchitecture(
  snapshot: Pick<
    ArchitectureSnapshot,
    | 'commonFacetImports'
    | 'commonRuntimeRootImports'
    | 'cycles'
    | 'deepImportsByPackage'
    | 'runtimeImportsFromDevDependencies'
    | 'undeclaredWorkspaceDependencies'
  >,
  baseline: CountBaseline,
): ArchitectureProblem[] {
  return [
    ...snapshot.cycles.map((cycle): ArchitectureProblem => ({
      kind: 'dependency-cycle',
      message: `Workspace dependency strongly connected group: ${cycle.join(', ')}`,
    })),
    ...compareExactCounts(
      snapshot.commonFacetImports,
      baseline.commonFacetImports,
      'common-facet-import',
      'Common imports a runtime facet',
    ),
    ...compareExactCounts(
      snapshot.commonRuntimeRootImports,
      baseline.commonRuntimeRootImports,
      'common-runtime-root-import',
      'Common imports a package root that exposes a runtime facet',
    ),
    ...compareExactCounts(
      snapshot.deepImportsByPackage,
      baseline.deepImportsByPackage,
      'deep-import',
      'Deep package imports',
    ),
    ...compareExactCounts(
      snapshot.runtimeImportsFromDevDependencies,
      baseline.runtimeImportsFromDevDependencies,
      'runtime-import-from-dev-dependency',
      'Runtime import declared only in devDependencies',
    ),
    ...compareExactCounts(
      snapshot.undeclaredWorkspaceDependencies,
      baseline.undeclaredWorkspaceDependencies,
      'undeclared-workspace-dependency',
      'Undeclared workspace dependency',
    ),
  ];
}

export function snapshotBaseline(snapshot: ArchitectureSnapshot): CountBaseline {
  return {
    commonFacetImports: toSortedRecord(snapshot.commonFacetImports),
    commonRuntimeRootImports: toSortedRecord(snapshot.commonRuntimeRootImports),
    deepImportsByPackage: toSortedRecord(snapshot.deepImportsByPackage),
    runtimeImportsFromDevDependencies: toSortedRecord(snapshot.runtimeImportsFromDevDependencies),
    undeclaredWorkspaceDependencies: toSortedRecord(snapshot.undeclaredWorkspaceDependencies),
  };
}

function parseBaseline(source: string, sourceName: string, missingFieldDefaults?: CountBaseline): CountBaseline {
  const parsed = JSON.parse(source) as Partial<CountBaseline>;
  for (const field of COUNT_BASELINE_FIELDS) {
    const fieldIsMissing = !Object.prototype.hasOwnProperty.call(parsed, field);
    const counts =
      fieldIsMissing && missingFieldDefaults && HISTORICALLY_OPTIONAL_BASELINE_FIELDS.has(field)
        ? missingFieldDefaults[field]
        : parsed[field];
    if (!counts || typeof counts !== 'object' || Array.isArray(counts)) {
      throw new Error(`${sourceName} must contain an object field named ${field}`);
    }
    parsed[field] = counts;
    for (const [key, value] of Object.entries(counts)) {
      if (!key || !Number.isInteger(value) || (value as number) <= 0) {
        throw new Error(`${sourceName} has an invalid ${field} count for ${key}`);
      }
    }
  }
  return parsed as CountBaseline;
}

export function readBranchBaseline(repoRoot: string): CountBaseline {
  const baselinePath = path.join(repoRoot, ARCHITECTURE_BASELINE_PATH);
  return parseBaseline(fs.readFileSync(baselinePath, 'utf8'), ARCHITECTURE_BASELINE_PATH);
}

export function readBaselineFromGit(
  repoRoot: string,
  ref: string,
  missingFieldDefaults?: CountBaseline,
): CountBaseline | undefined {
  const revision = spawnSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (revision.status !== 0) {
    throw new Error(`Architecture baseline ref does not resolve to a commit: ${ref}`);
  }
  const objectPath = `${ref}:${ARCHITECTURE_BASELINE_PATH}`;
  const result = spawnSync('git', ['show', objectPath], { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0) {
    return undefined;
  }
  return parseBaseline(result.stdout, objectPath, missingFieldDefaults);
}

function snapshotJson(snapshot: ArchitectureSnapshot): object {
  return {
    baseline: snapshotBaseline(snapshot),
    cycles: snapshot.cycles,
    edges: snapshot.edges.map(([source, target]) => ({ source, target })),
    nodes: snapshot.packages.map(({ name, root }) => ({ name, root: path.relative(process.cwd(), root) })),
  };
}

function optionValue(args: string[], name: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) {
    const value = inline.slice(name.length + 1);
    if (!value) {
      throw new Error(`${name} requires a non-empty git ref`);
    }
    return value;
  }
  const index = args.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a non-empty git ref`);
  }
  return value;
}

export function runCli(repoRoot: string, args: string[]): number {
  const snapshot = analyzeArchitecture(repoRoot);
  const branchBaseline = readBranchBaseline(repoRoot);
  const currentBaseline = snapshotBaseline(snapshot);
  const baselineRef = optionValue(args, '--baseline-ref') || process.env.ARCHITECTURE_BASELINE_REF?.trim();
  const problems = [...evaluateArchitecture(snapshot, branchBaseline), ...evaluatePackageImports(snapshot)];
  if (baselineRef) {
    // A field first introduced by this branch inherits the branch baseline for
    // this one historical comparison. Once merged, later branches compare it
    // monotonically like every older field.
    const baseBaseline = readBaselineFromGit(repoRoot, baselineRef, branchBaseline);
    if (baseBaseline) {
      problems.push(...evaluateBaselineHistory(branchBaseline, baseBaseline));
    } else {
      console.log(`Architecture baseline is new relative to ${baselineRef}; historical comparison skipped.`);
    }
  }
  if (args.includes('--print-baseline')) {
    console.log(JSON.stringify(currentBaseline, null, 2));
  }
  if (args.includes('--json')) {
    console.log(JSON.stringify(snapshotJson(snapshot), null, 2));
  }
  if (problems.length > 0) {
    console.error(`Architecture gate failed with ${problems.length} regression(s):`);
    for (const problem of problems) {
      console.error(`- [${problem.kind}] ${problem.message}`);
    }
    return 1;
  }
  if (!args.includes('--json') && !args.includes('--print-baseline')) {
    console.log(
      `Architecture gate passed: ${snapshot.packages.length} packages, ${snapshot.edges.length} internal edges, ` +
        `${snapshot.deepImportsByPackage.size} packages with baseline deep imports.`,
    );
  }
  return 0;
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runCli(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
