'use strict';
// Each rename is recoverable from the journal, including interruption between
// moving two top-level entries. The control plane commits metadata separately.
const fs = require('node:fs'),
  path = require('node:path');
const root = process.argv[2],
  action = process.argv[3],
  stage = process.argv[4];
const old = path.join(root, '.clouddev-restore-previous');
const journal = path.join(old, '.journal.json');
const contents = path.join(old, 'contents');
const remove = (p) => fs.rmSync(p, { recursive: true, force: true });
const save = (value) => {
  fs.writeFileSync(journal + '.tmp', JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(journal + '.tmp', journal);
};
function recover(commit) {
  if (!fs.existsSync(old)) return;
  if (!fs.existsSync(journal)) {
    if (commit) {
      remove(old);
      return;
    }
    if (
      fs.readdirSync(old).some((n) => n !== 'contents') ||
      (fs.existsSync(contents) && fs.readdirSync(contents).length)
    )
      throw new Error('恢复日志缺失，保留原文件等待检查');
    remove(old);
    return;
  }
  const j = JSON.parse(fs.readFileSync(journal, 'utf8'));
  if (commit) {
    if (j.phase !== 'applied') throw new Error('文件恢复尚未完成');
    const cache = path.join(contents, 'home/.m2/repository'),
      dest = path.join(root, 'home/.m2/repository');
    if (fs.existsSync(cache) && !fs.existsSync(dest)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(cache, dest);
    }
  } else {
    if (j.phase !== 'old') for (const name of j.next) if (!j.previous.includes(name)) remove(path.join(root, name));
    for (const name of j.previous)
      if (fs.existsSync(path.join(contents, name))) {
        remove(path.join(root, name));
        fs.renameSync(path.join(contents, name), path.join(root, name));
      }
  }
  remove(old);
}
try {
  if (action === 'apply') {
    recover(false);
    const previous = fs.readdirSync(root).filter((n) => path.join(root, n) !== stage),
      next = fs.readdirSync(stage);
    if (next.some((n) => n.startsWith('.clouddev-restore-'))) throw new Error('备份包含保留路径');
    fs.mkdirSync(contents, { mode: 0o700, recursive: true });
    const j = { previous, next, phase: 'old' };
    save(j);
    for (const name of previous) fs.renameSync(path.join(root, name), path.join(contents, name));
    j.phase = 'new';
    save(j);
    for (const name of next) fs.renameSync(path.join(stage, name), path.join(root, name));
    j.phase = 'applied';
    save(j);
  } else if (action === 'commit' || action === 'rollback') recover(action === 'commit');
  else throw new Error('未知恢复操作');
} catch (e) {
  process.stderr.write(e.message + '\n');
  process.exitCode = 1;
}
