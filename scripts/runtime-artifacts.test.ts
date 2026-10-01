import assert from 'node:assert/strict';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { runtimeRecipes } from './build-runtime.ts';
import { buildArtifacts, inspectArtifacts } from './runtime-artifacts.ts';

import type { ArtifactRecipe } from './runtime-artifacts.ts';

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'opensumi-artifacts-'));
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src/main.ts'), 'version one');
  const recipe: ArtifactRecipe = {
    id: 'fixture',
    inputs: ['src'],
    outputs: ['dist'],
    requiredOutputs: ['dist/main.js'],
    toolchain: { node: process.version },
    commands: [['build']],
  };
  const build = async () => {
    mkdirSync(path.join(root, 'dist'), { recursive: true });
    writeFileSync(path.join(root, 'dist/main.js'), readFileSync(path.join(root, 'src/main.ts')));
  };
  return { root, recipe, build, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('the product receipt is invalidated when its pre-build runtime policy changes', async (t) => {
  const { root, recipe: fixtureRecipe, build, cleanup } = fixture();
  t.after(cleanup);
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const javascript = runtimeRecipes(repoRoot, 'node').find((recipe) => recipe.id === 'javascript')!;
  const policy = 'packages/startup/bootstrap/runtime-mode.cjs';
  mkdirSync(path.dirname(path.join(root, policy)), { recursive: true });
  cpSync(path.join(repoRoot, policy), path.join(root, policy));
  const recipe = {
    ...javascript,
    outputs: fixtureRecipe.outputs,
    requiredOutputs: fixtureRecipe.requiredOutputs,
  };
  await buildArtifacts(root, recipe, build);
  assert.equal(inspectArtifacts(root, recipe).fresh, true);
  writeFileSync(path.join(root, policy), readFileSync(path.join(root, policy), 'utf8') + '\n// changed policy\n');
  assert.equal(inspectArtifacts(root, recipe).fresh, false);
});

test('only a completed build with matching input and output content is fresh', async (t) => {
  const { root, recipe, build, cleanup } = fixture();
  t.after(cleanup);
  assert.equal(inspectArtifacts(root, recipe).fresh, false);
  await buildArtifacts(root, recipe, build);
  assert.equal(inspectArtifacts(root, recipe).fresh, true);
  const source = path.join(root, 'src/main.ts');
  const original = statSync(source);
  writeFileSync(source, 'version two');
  utimesSync(source, original.atime, original.mtime);
  assert.equal(inspectArtifacts(root, recipe).fresh, false, 'same length and timestamp must not hide stale code');
  await buildArtifacts(root, recipe, build);
  assert.equal(inspectArtifacts(root, recipe).fresh, true);
  recipe.toolchain.node = 'a different compiler';
  assert.equal(inspectArtifacts(root, recipe).fresh, false);
});

test('source additions/deletions and recipe changes invalidate the build', async (t) => {
  const { root, recipe, build, cleanup } = fixture();
  t.after(cleanup);
  await buildArtifacts(root, recipe, build);
  writeFileSync(path.join(root, 'src/extra.ts'), 'added');
  assert.equal(inspectArtifacts(root, recipe).fresh, false);
  await buildArtifacts(root, recipe, build);
  rmSync(path.join(root, 'src/extra.ts'));
  assert.equal(inspectArtifacts(root, recipe).fresh, false);
  await buildArtifacts(root, recipe, build);
  recipe.commands.push(['another-build-stage']);
  assert.equal(inspectArtifacts(root, recipe).fresh, false);
});

test('output corruption, removal and extra retired output are detected', async (t) => {
  const { root, recipe, build, cleanup } = fixture();
  t.after(cleanup);
  await buildArtifacts(root, recipe, build);
  writeFileSync(path.join(root, 'dist/main.js'), 'stale build');
  assert.equal(inspectArtifacts(root, recipe).fresh, false);
  await buildArtifacts(root, recipe, build);
  writeFileSync(path.join(root, 'dist/retired.js'), 'deleted source still present');
  assert.equal(inspectArtifacts(root, recipe).fresh, false);
  rmSync(path.join(root, 'dist/retired.js'));
  assert.equal(inspectArtifacts(root, recipe).fresh, true);
  rmSync(path.join(root, 'dist/main.js'));
  assert.match(inspectArtifacts(root, recipe).reason, /missing outputs/);
});

test('failure and concurrent source edits cannot leave a valid receipt', async (t) => {
  const { root, recipe, build, cleanup } = fixture();
  t.after(cleanup);
  await buildArtifacts(root, recipe, build);
  await assert.rejects(
    buildArtifacts(root, recipe, async () => {
      throw new Error('compiler failed');
    }),
    /compiler failed/,
  );
  assert.equal(inspectArtifacts(root, recipe).fresh, false);
  await assert.rejects(
    buildArtifacts(root, recipe, async () => {
      await build();
      writeFileSync(path.join(root, 'src/main.ts'), 'edited during compile');
    }),
    /inputs changed during the build/,
  );
  assert.equal(inspectArtifacts(root, recipe).fresh, false);
});

test('successful commands without the required output cannot certify a build', async (t) => {
  const { root, recipe, cleanup } = fixture();
  t.after(cleanup);
  await assert.rejects(
    buildArtifacts(root, recipe, async () => {}),
    /without required outputs/,
  );
  assert.equal(inspectArtifacts(root, recipe).fresh, false);
});

test('receipts are deterministic and executable permissions are part of native output identity', async (t) => {
  const { root, recipe, build, cleanup } = fixture();
  t.after(cleanup);
  await buildArtifacts(root, recipe, build);
  const receipt = path.join(root, '.cache/runtime-artifacts/fixture.json');
  const first = readFileSync(receipt, 'utf8');
  await buildArtifacts(root, recipe, build);
  assert.equal(readFileSync(receipt, 'utf8'), first);
  if (process.platform !== 'win32') {
    chmodSync(path.join(root, 'dist/main.js'), 0o755);
    assert.equal(inspectArtifacts(root, recipe).fresh, false);
  }
});

test('a receipt copied to another workspace cannot certify embedded build paths', async (t) => {
  const original = fixture();
  const relocated = fixture();
  t.after(original.cleanup);
  t.after(relocated.cleanup);
  await buildArtifacts(original.root, original.recipe, original.build);
  cpSync(original.root, relocated.root, { recursive: true });
  assert.equal(inspectArtifacts(relocated.root, relocated.recipe).fresh, false);
});

test('generated sources and another build stage can be excluded without hiding owned outputs', async (t) => {
  const { root, recipe, build, cleanup } = fixture();
  t.after(cleanup);
  recipe.excludeInputs = ['src/generated.ts'];
  recipe.excludeOutputs = ['dist/native'];
  await buildArtifacts(root, recipe, async () => {
    await build();
    writeFileSync(path.join(root, 'src/generated.ts'), 'generated');
  });
  mkdirSync(path.join(root, 'dist/native'));
  writeFileSync(path.join(root, 'dist/native/agent'), 'native build');
  assert.equal(inspectArtifacts(root, recipe).fresh, true);
  writeFileSync(path.join(root, 'dist/main.js'), 'stale JavaScript');
  assert.equal(inspectArtifacts(root, recipe).fresh, false);
});
