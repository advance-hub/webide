'use strict';

// 将可编辑的默认连接写入 IDE 用户设置。输入文件
// 由控制面上传，命令结束后删除；凭据不会
// 打印到日志，也不会保存到工作区元数据。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const name = 'CloudDev MySQL';
const redisKey = 'redis-state-explorer.redisUrl';
const mysqlKey = 'sqltools.connections';
const autoKey = 'sqltools.autoConnectTo';

function readJSON(filename, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function object(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('IDE 设置必须是 JSON 对象');
  return value;
}

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function writeJSON(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(filename), 0o700);
  const temporary = `${filename}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, filename);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function paths(root) {
  const directory = path.join(root, 'home', '.sumi');
  return {
    settings: path.join(directory, 'settings.json'),
    marker: path.join(directory, '.opensumi-editor-connections.json'),
  };
}

function redisURL(profile) {
  const result = new URL(`redis://${profile.endpoint}`);
  if (profile.username) result.username = profile.username;
  if (profile.password) result.password = profile.password;
  result.pathname = `/${profile.database || '0'}`;
  return result.href;
}

function mysqlConnection(profile) {
  const index = profile.endpoint.lastIndexOf(':');
  if (index < 1) throw new Error('MySQL 连接地址无效');
  const server = profile.endpoint.slice(0, index).replace(/^\[|\]$/g, '');
  const port = Number(profile.endpoint.slice(index + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MySQL 端口无效');
  return {
    name,
    group: 'CloudDev',
    driver: 'MySQL',
    server,
    port,
    database: profile.database || '',
    username: profile.username || '',
    password: profile.password || '',
  };
}

function revokeMySQL(settings, marker) {
  if (!marker.mysqlHash || !Array.isArray(settings[mysqlKey])) return;
  settings[mysqlKey] = settings[mysqlKey]
    .filter((item) => item?.name !== name)
    .map((item) => {
      if (marker.mysqlPasswordHash && item?.password && hash(item.password) === marker.mysqlPasswordHash) {
        return { ...item, password: '' };
      }
      return item;
    });
  if (Array.isArray(settings[autoKey])) settings[autoKey] = settings[autoKey].filter((item) => item !== name);
  delete marker.mysqlHash;
  delete marker.mysqlPasswordHash;
  delete marker.autoManaged;
}

function revokeRedis(settings, marker) {
  if (!marker.redisHash || typeof settings[redisKey] !== 'string') return;
  if (hash(settings[redisKey]) === marker.redisHash) {
    delete settings[redisKey];
  } else {
    // 保留用户手动修改的主机和数据库，并移除继承的认证信息。
    try {
      const url = new URL(settings[redisKey]);
      url.username = '';
      url.password = '';
      settings[redisKey] = url.href;
    } catch {
      delete settings[redisKey];
    }
  }
  delete marker.redisHash;
}

function install(root, input) {
  const file = paths(root);
  const settings = object(readJSON(file.settings, {}));
  const marker = object(readJSON(file.marker, {}));
  const spec = object(readJSON(input, {}));
  if (spec.mysql) {
    const connection = mysqlConnection(spec.mysql);
    const existing = settings[mysqlKey];
    if (existing !== undefined && !Array.isArray(existing)) throw new Error('SQLTools 连接设置不是数组');
    const connections = existing || [];
    const index = connections.findIndex((item) => item?.name === name);
    if (index === -1 && !marker.mysqlHash) {
      connections.push(connection);
      marker.mysqlHash = hash(connection);
      marker.mysqlPasswordHash = connection.password ? hash(connection.password) : '';
      settings[mysqlKey] = connections;
    } else if (index >= 0 && marker.mysqlHash === hash(connections[index])) {
      connections[index] = connection;
      marker.mysqlHash = hash(connection);
      marker.mysqlPasswordHash = connection.password ? hash(connection.password) : '';
      settings[mysqlKey] = connections;
    }
    if (marker.mysqlHash && !marker.autoManaged) {
      const current = settings[autoKey];
      if (current === undefined) settings[autoKey] = [name];
      else if (typeof current === 'string') settings[autoKey] = current === name ? [name] : [current, name];
      else if (Array.isArray(current) && !current.includes(name)) settings[autoKey] = [...current, name];
      marker.autoManaged = true;
    }
  } else revokeMySQL(settings, marker);
  if (spec.redis) {
    const url = redisURL(spec.redis);
    if (settings[redisKey] === undefined && !marker.redisHash) {
      settings[redisKey] = url;
      marker.redisHash = hash(url);
    } else if (marker.redisHash && marker.redisHash === hash(settings[redisKey])) {
      settings[redisKey] = url;
      marker.redisHash = hash(url);
    }
  } else revokeRedis(settings, marker);
  writeJSON(file.settings, settings);
  writeJSON(file.marker, marker);
  return {
    mysql: !!marker.mysqlHash && settings[mysqlKey]?.some((item) => item?.name === name),
    redis: !!marker.redisHash && settings[redisKey] !== undefined,
    additionalDatabases: Array.isArray(settings[mysqlKey])
      ? settings[mysqlKey].filter((item) => item?.name !== name).length
      : 0,
  };
}

function remove(root) {
  const file = paths(root);
  const settings = object(readJSON(file.settings, {}));
  const marker = object(readJSON(file.marker, {}));
  revokeMySQL(settings, marker);
  revokeRedis(settings, marker);
  writeJSON(file.settings, settings);
  if (fs.existsSync(file.marker)) fs.unlinkSync(file.marker);
  return {
    mysql: false,
    redis: false,
    additionalDatabases: Array.isArray(settings[mysqlKey]) ? settings[mysqlKey].length : 0,
  };
}

function main() {
  const action = process.argv[2];
  const root = path.resolve(process.argv[3] || '/workspace');
  let result;
  if (action === 'install') result = install(root, process.argv[4]);
  else if (action === 'remove') result = remove(root);
  else throw new Error('未知编辑器连接操作');
  process.stdout.write(JSON.stringify(result));
}

module.exports = { install, remove, mysqlConnection, redisURL };
if (require.main === module) main();
