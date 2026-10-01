'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const development = require('./development.cjs');
const toolchain = require('./toolchain.cjs');
const root = path.resolve(process.argv[2]);
const input = JSON.parse(
  process.argv[3].startsWith('@')
    ? fs.readFileSync(process.argv[3].slice(1), 'utf8')
    : Buffer.from(process.argv[3], 'base64').toString(),
);
const filename = path.join(root, 'project/.opensumi/development.json');
const read = () => (fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8') : '{"version":1}');
const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
async function main() {
  if (input.port) process.env.CLOUDDEV_PREVIEW_PORT = String(input.port);
  const java = toolchain.selected(root);
  process.env.JAVA_HOME = java.home;
  process.env.HOME = path.join(root, 'home');
  process.env.PATH = java.home + '/bin:/opt/maven/bin:' + process.env.PATH;
  const config = development.loadConfig(root);
  const names = config?.services ? config.services.map((s) => s.name) : config?.run ? ['default'] : [];
  if (['start', 'stop', 'restart', 'log'].includes(input.action) && !names.includes(input.name))
    throw new Error('请选择已配置的任务');
  if (input.action === 'save') {
    if ((await development.services(root)).services.some((s) => s.running))
      throw new Error('请先停止当前运行任务，再修改启动配置');
    if (typeof input.text !== 'string' || Buffer.byteLength(input.text) > 32768 || input.revision !== hash(read()))
      throw new Error('配置已变化，请重新读取后保存');
    const parsed = JSON.parse(input.text);
    for (const name of parsed.services?.map((s) => s.name) || [undefined]) development.loadConfig(root, name, parsed);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename + '.tmp', input.text, { mode: 0o600 });
    fs.renameSync(filename + '.tmp', filename);
  } else if (input.action === 'log') {
    const file = path.join(development.platformPath(root, input.name), 'development.log');
    if (!fs.existsSync(file)) return { text: '暂无日志' };
    const size = fs.statSync(file).size,
      length = Math.min(size, 65536),
      buffer = Buffer.alloc(length),
      fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buffer, 0, length, size - length);
    } finally {
      fs.closeSync(fd);
    }
    return {
      text: buffer
        .toString()
        .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[REDACTED]@')
        .replace(/((?:password|passwd|token|secret|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]'),
      truncated: size > length,
    };
  } else if (['start', 'stop', 'restart'].includes(input.action)) {
    if (input.action !== 'start') await development.stop(root, input.name);
    if (input.action !== 'stop') {
      await development.run(root, 'initialize');
      await development.run(root, 'start', input.name === 'default' ? undefined : input.name);
    }
  } else if (input.action !== 'status') throw new Error('未知运行任务操作');
  const text = read();
  return { ...(await development.services(root)), text, revision: hash(text) };
}
main()
  .then((result) => process.stdout.write(JSON.stringify(result)))
  .catch((e) => {
    process.stdout.write(JSON.stringify({ error: e.message }));
    process.exitCode = 1;
  });
