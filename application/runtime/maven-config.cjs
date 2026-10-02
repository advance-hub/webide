'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const toolchain = require('./toolchain.cjs');
const root = path.resolve(process.argv[2]);
const input = require('./command-input.cjs').readCommandInput(process.argv[3]);
const settings = path.join(root, 'home/.m2/settings.xml');
const dir = path.join(root, 'home/.clouddev');
const presets = path.join(dir, 'maven-presets.json');
const read = (file, fallback = '') => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : fallback);
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file + '.new', value, { mode: 0o600 });
  fs.renameSync(file + '.new', file);
}
try {
  if (input.action === 'save-settings') {
    if (
      typeof input.xml !== 'string' ||
      Buffer.byteLength(input.xml) > 65536 ||
      input.revision !== hash(read(settings))
    )
      throw new Error('配置已被其他窗口修改，请重新读取后保存');
    const parsed = spawnSync(
      'python3',
      [
        '-c',
        'import sys,xml.etree.ElementTree as E\ns=sys.stdin.read()\nassert "<!DOCTYPE" not in s.upper() and "<!ENTITY" not in s.upper()\nassert E.fromstring(s).tag.rsplit("}",1)[-1]=="settings"',
      ],
      { input: input.xml, timeout: 5000 },
    );
    if (parsed.status !== 0) throw new Error('请填写有效的 Maven settings.xml，不支持 XML 实体');
    write(settings, input.xml);
    fs.rmSync(path.join(root, 'home/.m2/.opensumi-settings-sha256'), { force: true });
  } else if (input.action === 'save-jdk') {
    toolchain.selected(root, input.jdk);
    write(path.join(dir, 'toolchain.json'), JSON.stringify({ jdk: input.jdk }));
    const ideSettings = path.join(root, 'home/.sumi/settings.json');
    const ide = JSON.parse(read(ideSettings, '{}'));
    ide['java.configuration.runtimes'] = toolchain.available().map((jdk) => ({
      name: `JavaSE-${jdk === '8' ? '1.8' : jdk}`,
      path: toolchain.selected(root, jdk).home,
      default: jdk === input.jdk,
    }));
    ide['java.jdt.ls.java.home'] = '/opt/java/openjdk';
    write(ideSettings, JSON.stringify(ide, null, 2));
  } else if (input.action === 'save-presets') {
    if (!Array.isArray(input.presets) || input.presets.length > 12 || JSON.stringify(input.presets).length > 24000)
      throw new Error('最多保存 12 个构建方案');
    write(presets, JSON.stringify(input.presets));
  } else if (input.action !== 'read') throw new Error('未知 Maven 配置操作');
  const xml = read(settings);
  process.stdout.write(
    JSON.stringify({
      xml,
      revision: hash(xml),
      jdk: toolchain.selected(root).version,
      jdks: toolchain.available(),
      presets: JSON.parse(read(presets, '[]')),
    }),
  );
} catch (e) {
  process.stdout.write(JSON.stringify({ error: e.message }));
  process.exitCode = 1;
}
