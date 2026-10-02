'use strict';
const fs = require('node:fs');
const path = require('node:path');

// 标准 JDK 和 Maven 分发包已有版本元数据，直接读取这些文件
// 可避免每次检查启动两个 JVM，在模拟架构运行时尤其重要。
function installedVersion(binary, environment) {
  const executable = (environment.PATH || '')
    .split(path.delimiter)
    .map((dir) => path.join(dir, binary))
    .find((file) => {
      try {
        fs.accessSync(file, fs.constants.X_OK);
        return fs.statSync(file).isFile();
      } catch {
        return false;
      }
    });
  if (!executable) return '';
  try {
    const home = path.dirname(path.dirname(fs.realpathSync(executable)));
    if (binary === 'java') {
      const version = fs.readFileSync(path.join(home, 'release'), 'utf8').match(/^JAVA_VERSION="([^"]+)"/m)?.[1];
      if (version) return `java version "${version}"`;
    }
    if (binary === 'mvn') {
      const core = fs.readdirSync(path.join(home, 'lib')).find((name) => /^maven-core-[\w.-]+\.jar$/.test(name));
      if (core) return 'Apache Maven ' + core.slice('maven-core-'.length, -'.jar'.length);
    }
  } catch {}
  return undefined;
}
module.exports = { installedVersion };
