'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const tar = require(require.resolve('tar', { paths: [path.join(__dirname, '../..'), '/app'] }));
const cap = 5 * 1024 * 1024 * 1024;
function validateName(name) {
  if (
    !name ||
    name.includes('\0') ||
    name.includes('\\') ||
    name.startsWith('/') ||
    /^[a-z]:/i.test(name) ||
    name.split('/').includes('..') ||
    name.split('/')[0].startsWith('.clouddev-restore-')
  )
    throw new Error('备份包含不安全路径');
}
async function validate(file) {
  let entries = 0,
    bytes = 0;
  const parser = tar.t({
    strict: true,
    onReadEntry(entry) {
      try {
        validateName(entry.path);
        if (!['File', 'Directory', 'SymbolicLink', 'Link'].includes(entry.type))
          throw new Error('备份包含不支持的文件类型');
        if (++entries > 100000 || (bytes += entry.size) > cap) throw new Error('备份解压超过上限');
        if (entry.linkpath) {
          const target =
            entry.type === 'SymbolicLink'
              ? path.posix.join(path.posix.dirname(entry.path), entry.linkpath)
              : entry.linkpath;
          if (path.posix.isAbsolute(entry.linkpath)) throw new Error('备份不能包含绝对链接');
          validateName(target);
        }
      } catch (error) {
        parser.abort(error);
      }
    },
  });
  await pipeline(fs.createReadStream(file), parser);
}
async function run(root, action, file) {
  if (action === 'export') {
    await tar.c(
      {
        file,
        cwd: root,
        gzip: true,
        portable: true,
        filter(name) {
          return (
            !name
              .split('/')
              .some(
                (part) =>
                  part.startsWith('.clouddev-restore-') ||
                  ['ide.pid', 'ide-owner.json', 'ide-start.lock', 'clouddev-bridge.json'].includes(part),
              ) &&
            !/(?:^|\/)home\/\.m2\/repository(?:\/|$)/.test(name) &&
            !/\.(?:log|sock)$/.test(name)
          );
        },
      },
      fs.readdirSync(root),
    );
    fs.chmodSync(file, 0o600);
    if (fs.statSync(file).size > cap) throw new Error('备份超过 5 GiB');
    await validate(file);
  } else if (action === 'stage') {
    await validate(file);
    const stage = path.join(root, '.clouddev-restore-next');
    if (fs.existsSync(stage)) throw new Error('上一次恢复暂存区尚未清理，请先恢复任务');
    fs.mkdirSync(stage, { mode: 0o700 });
    try {
      await tar.x({ file, cwd: stage, strict: true, preservePaths: false });
    } catch (error) {
      fs.rmSync(stage, { recursive: true, force: true });
      throw error;
    }
  } else throw new Error('未知备份操作');
}
module.exports = { run, validate };
if (require.main === module)
  run(process.argv[2], process.argv[3], process.argv[4]).catch((error) => {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  });
