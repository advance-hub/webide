'use strict';
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.WORKBENCH_MACHINE_HOME || '/workspace/home';
function read(file, fallback = {}) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
}
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}
function safeSettings(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) =>
      /^(editor\.|files\.|workbench\.|general\.|terminal\.|ai\.native\.)/.test(key),
    ),
  );
}
function inherit(root, sharedHome = home) {
  const local = path.join(root, 'home');
  fs.mkdirSync(local, { recursive: true });
  for (const relative of ['.config/opencode', '.local/share/opencode']) {
    const shared = path.join(sharedHome, relative),
      target = path.join(local, relative);
    fs.mkdirSync(shared, { recursive: true, mode: 0o700 });
    if (shared === target) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target) && !fs.lstatSync(target).isSymbolicLink()) {
      // 保留旧用户目录前，合并缺失的认证提供方与设置。
      for (const name of ['auth.json', 'opencode.json']) {
        const source = path.join(target, name),
          destination = path.join(shared, name);
        if (fs.existsSync(source)) write(destination, { ...read(source), ...read(destination) });
      }
      const retained = target + '.before-personal';
      if (fs.existsSync(retained)) throw new Error('个人配置迁移备份已存在，请检查后重试');
      fs.renameSync(target, retained);
    }
    if (!fs.existsSync(target)) fs.symlinkSync(shared, target, 'dir');
  }
  const defaults = read(path.join(sharedHome, '.clouddev/editor-defaults.json'));
  const file = path.join(local, '.sumi/settings.json'),
    marker = path.join(local, '.clouddev/inherited-settings.json');
  const current = read(file),
    previous = read(marker),
    applied = {};
  for (const [key, value] of Object.entries(defaults)) {
    if (!(key in current) || JSON.stringify(current[key]) === JSON.stringify(previous[key])) {
      current[key] = value;
      applied[key] = value;
    }
  }
  for (const key of Object.keys(previous))
    if (!(key in defaults) && JSON.stringify(current[key]) === JSON.stringify(previous[key])) delete current[key];
  write(file, current);
  write(marker, applied);
}
module.exports = { read, write, safeSettings, inherit, home };
if (require.main === module) {
  try {
    inherit(path.resolve(process.argv[2]));
  } catch (e) {
    process.stderr.write(e.message);
    process.exitCode = 1;
  }
}
