'use strict';
const fs = require('node:fs'),
  path = require('node:path');
const personal = require('./personal-settings.cjs');
const root = path.resolve(process.argv[2]);
const input = JSON.parse(
  process.argv[3].startsWith('@')
    ? fs.readFileSync(process.argv[3].slice(1), 'utf8')
    : Buffer.from(process.argv[3], 'base64').toString(),
);
try {
  const file = path.join(personal.home, '.clouddev/editor-defaults.json');
  if (input.action === 'save') {
    if (
      !input.settings ||
      typeof input.settings !== 'object' ||
      Array.isArray(input.settings) ||
      JSON.stringify(input.settings).length > 32768
    )
      throw new Error('编辑器偏好必须是最多 32 KiB 的 JSON 对象');
    const settings = personal.safeSettings(input.settings);
    if (Object.keys(settings).length !== Object.keys(input.settings).length)
      throw new Error('个人偏好仅支持 editor、files、workbench、general、terminal 和 ai.native 设置');
    personal.write(file, settings);
  } else if (input.action === 'use-current') {
    personal.write(file, personal.safeSettings(personal.read(path.join(root, 'home/.sumi/settings.json'))));
  } else if (input.action !== 'read' && input.action !== 'apply') throw new Error('未知个人配置操作');
  if (input.action !== 'read') personal.inherit(root);
  process.stdout.write(JSON.stringify({ settings: personal.read(file), sharedAI: true }));
} catch (e) {
  process.stdout.write(JSON.stringify({ error: e.message }));
  process.exitCode = 1;
}
