'use strict';
const fs = require('node:fs');
const path = require('node:path');
const homes = { 8: '/opt/java/8', 11: '/opt/java/11', 17: '/opt/java/17', 21: '/opt/java/openjdk' };
function selected(root, override) {
  let configured = '21';
  const file = path.join(root, 'home/.clouddev/toolchain.json');
  if (fs.existsSync(file)) configured = JSON.parse(fs.readFileSync(file, 'utf8')).jdk || '21';
  const version = override || configured;
  if (!homes[version]) throw new Error('JDK 必须为 8、11、17 或 21');
  if ((override || fs.existsSync(file)) && !fs.existsSync(homes[version] + '/bin/java'))
    throw new Error(`镜像尚未安装 JDK ${version}，请更新开发机运行时`);
  return { version, home: homes[version] };
}
function available() {
  return Object.entries(homes)
    .filter(([, home]) => fs.existsSync(home + '/bin/java'))
    .map(([version]) => version);
}
module.exports = { selected, available };
if (require.main === module) {
  try {
    process.stdout.write(selected(process.argv[2]).home);
  } catch (e) {
    process.stderr.write(e.message);
    process.exitCode = 1;
  }
}
