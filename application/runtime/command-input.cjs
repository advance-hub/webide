'use strict';

const fs = require('node:fs');

/** 私有输入文件与历史 Base64 参数共用同一解析入口。 */
function readCommandInput(argument) {
  const text = argument.startsWith('@')
    ? fs.readFileSync(argument.slice(1), 'utf8')
    : Buffer.from(argument, 'base64').toString('utf8');
  return JSON.parse(text);
}

module.exports = { readCommandInput };
