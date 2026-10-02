'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const toolchain = require('./toolchain.cjs');
const { installedVersion } = require('./tool-versions.cjs');

const root = path.resolve(process.argv[3] || '/workspace');
const action = process.argv[2] || 'inspect';
const project = path.join(root, 'project');
const home = path.join(root, 'home');
const settings = path.join(home, '.m2', 'settings.xml');
const marker = path.join(home, '.m2', '.opensumi-settings-sha256');
const repository = path.join(home, '.m2', 'repository');
const stateFile = path.join(root, '.platform', 'maven-last.json');
const goals = {
  prepare: 'dependency:go-offline',
  build: 'package',
  test: 'test',
  verify: 'verify',
  install: 'install',
  tree: 'dependency:tree',
};
const env = { ...process.env, HOME: home, MAVEN_OPTS: process.env.MAVEN_OPTS || '-Xmx512m' };
if (fs.existsSync('/opt/java/openjdk/bin/java')) {
  env.JAVA_HOME = '/opt/java/openjdk';
  env.PATH = '/opt/java/openjdk/bin:/opt/maven/bin:' + env.PATH;
}

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}
function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file + '.tmp', JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}
function options() {
  const encoded = process.argv[4];
  if (encoded && encoded.length > 22000) throw new Error('Maven 参数过长');
  const value = encoded ? JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) : {};
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== 'object' ||
    Object.keys(value).some(
      (key) =>
        ![
          'id',
          'pom',
          'profiles',
          'modules',
          'alsoMake',
          'skipTests',
          'offline',
          'updateSnapshots',
          'clean',
          'jdk',
          'timeoutMinutes',
        ].includes(key),
    )
  )
    throw new Error('Maven 参数无效');
  if (value.id !== undefined && !/^[a-f0-9]{32}$/.test(value.id)) throw new Error('任务标识无效');
  if (value.jdk !== undefined && !['8', '11', '17', '21', ''].includes(value.jdk)) throw new Error('JDK 版本无效');
  if (
    value.timeoutMinutes !== undefined &&
    (!Number.isInteger(value.timeoutMinutes) || value.timeoutMinutes < 1 || value.timeoutMinutes > 60)
  )
    throw new Error('任务时限为 1–60 分钟');
  if (value.pom !== undefined && (typeof value.pom !== 'string' || value.pom.length > 1024 || value.pom.includes('\0')))
    throw new Error('POM 路径无效');
  for (const key of ['profiles', 'modules']) {
    if (
      value[key] !== undefined &&
      (!Array.isArray(value[key]) ||
        value[key].length > 64 ||
        value[key].some(
          (v) =>
            typeof v !== 'string' || !/^[A-Za-z0-9_.:][A-Za-z0-9_./:-]{0,255}$/.test(v) || v.split('/').includes('..'),
        ))
    )
      throw new Error('Profile 或模块参数无效');
  }
  for (const key of ['alsoMake', 'skipTests', 'offline', 'updateSnapshots', 'clean'])
    if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new Error('Maven 开关无效');
  if (['test', 'verify'].includes(action) && value.skipTests) throw new Error('测试和校验任务不能跳过测试');
  if (value.offline && value.updateSnapshots) throw new Error('离线构建不能强制更新快照');
  return value;
}
function location(opts) {
  const base = fs.realpathSync(project);
  const config = readJSON(path.join(base, '.opensumi', 'development.json'));
  const relative = config?.cwd || '.';
  if (typeof relative !== 'string') throw new Error('项目工作目录无效');
  const cwd = fs.realpathSync(path.resolve(base, relative));
  if (cwd !== base && !cwd.startsWith(base + path.sep)) throw new Error('项目工作目录超出仓库');
  const supplied = path.resolve(base, opts.pom || path.relative(base, path.join(cwd, 'pom.xml')));
  const pom = fs.existsSync(supplied) ? fs.realpathSync(supplied) : supplied;
  if (!pom.startsWith(base + path.sep) || !pom.endsWith('.xml')) throw new Error('POM 路径超出仓库或不是 XML');
  return { base, cwd: path.dirname(pom), pom };
}
function metadata(pom) {
  const result = spawnSync('python3', [path.join(__dirname, 'maven-metadata.py'), project, pom, settings], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) throw new Error('POM 或 settings.xml 元数据读取失败，请检查 XML 与模块路径');
  return JSON.parse(result.stdout);
}
function commandVersion(binary, args) {
  const installed = installedVersion(binary, env);
  if (installed !== undefined) return installed;
  const r = spawnSync(binary, args, { encoding: 'utf8', timeout: 5000, env });
  if (r.error?.code === 'ETIMEDOUT') throw new Error(`${binary} 版本检查超时，请稍后重试；未判定为工具缺失`);
  return (r.stdout || r.stderr || '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split('\n')[0]
    .trim();
}
function wrapperFor(pom) {
  const candidates = [path.join(path.dirname(pom), 'mvnw'), path.join(project, 'mvnw')];
  return candidates.find((file) => fs.existsSync(file));
}
function inspect(opts = {}) {
  const java = toolchain.selected(root, opts.jdk);
  if (fs.existsSync(java.home + '/bin/java')) {
    env.JAVA_HOME = java.home;
    env.PATH = java.home + '/bin:/opt/maven/bin:' + process.env.PATH;
  }
  const { pom } = location(opts);
  const { secrets: _, ...info } = metadata(pom);
  const last = readJSON(stateFile);
  return {
    ...info,
    detected: fs.existsSync(pom),
    pom: fs.existsSync(pom) ? path.relative(fs.realpathSync(project), pom) : '',
    java: commandVersion('java', ['-version']),
    maven: commandVersion('mvn', ['-version']),
    jdk: java.version,
    jdks: toolchain.available(),
    wrapper: !!wrapperFor(pom),
    settings: fs.existsSync(settings),
    managedSettings:
      fs.existsSync(settings) &&
      fs.existsSync(marker) &&
      fs.readFileSync(marker, 'utf8').trim() ===
        crypto.createHash('sha256').update(fs.readFileSync(settings)).digest('hex'),
    repository: fs.existsSync(repository) ? fs.realpathSync(repository) : repository,
    lastAction: last?.action || '',
    lastStatus: last?.status || '',
    lastAt: last?.at || '',
    log: last?.log || '',
    command: last?.command || [],
    jobId: last?.id || '',
  };
}
function logResult(opts) {
  const state = opts.id ? readJSON(path.join(root, '.platform', 'maven', opts.id + '.json')) : readJSON(stateFile);
  if (!state) return { text: '', truncated: false };
  if (!/^[a-f0-9]{32}$/.test(state.id || '')) return { text: '旧任务日志请在终端查看', truncated: false };
  const file = path.join(root, '.platform', 'maven', state.id + '.log');
  if (!fs.existsSync(file)) return { text: '', truncated: false };
  const size = fs.statSync(file).size,
    length = Math.min(size, 65536);
  const buffer = Buffer.alloc(length),
    fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buffer, 0, length, size - length);
  } finally {
    fs.closeSync(fd);
  }
  // 任务日志接口不得将凭据带出沙箱。
  const { pom } = location(state.options || {});
  const values = metadata(pom).secrets || [];
  let text = buffer.toString('utf8').replace(/\x1b\[[0-9;]*m/g, '');
  if (size > length) {
    const newline = text.indexOf('\n');
    text = newline < 0 ? '' : text.slice(newline + 1);
  }
  for (const secret of values.filter(Boolean).sort((a, b) => b.length - a.length))
    text = text.split(secret).join('[REDACTED]');
  text = text
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[REDACTED]@')
    .replace(/((?:password|passwd|token|secret|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]');
  return { text, truncated: size > length, jobId: state.id, status: state.status };
}
async function execute(opts) {
  const report = inspect(opts);
  if (!report.detected) throw new Error('当前分支没有 Maven pom.xml');
  if (!report.java) throw new Error('当前开发镜像缺少 JDK');
  if (!report.wrapper && !report.maven) throw new Error('当前开发镜像缺少 Maven');
  const { cwd, pom } = location(opts);
  const binary = report.wrapper ? '/bin/sh' : 'mvn';
  const args = report.wrapper ? [wrapperFor(pom)] : [];
  args.push('-B', '-ntp');
  if (report.settings) args.push('-s', settings);
  args.push('-Dmaven.repo.local=' + repository, '-f', pom);
  if (opts.profiles?.length) args.push('-P', opts.profiles.join(','));
  if (opts.modules?.length) {
    args.push('-pl', opts.modules.join(','));
    if (opts.alsoMake !== false) args.push('-am');
  }
  if (opts.skipTests) args.push('-DskipTests');
  if (opts.offline) args.push('-o');
  if (opts.updateSnapshots) args.push('-U');
  if (opts.clean) args.push('clean');
  args.push(goals[action]);
  const id = opts.id || crypto.randomBytes(16).toString('hex');
  const log = path.join(root, '.platform', 'maven', id + '.log');
  const history = path.join(root, '.platform', 'maven', id + '.json');
  fs.mkdirSync(repository, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(log), { recursive: true, mode: 0o700 });
  const state = {
    id,
    action,
    status: 'running',
    at: new Date().toISOString(),
    log,
    options: opts,
    command: [binary, ...args],
  };
  const save = () => {
    writeJSON(history, state);
    writeJSON(stateFile, state);
  };
  const cancelFile = path.join(root, '.platform', 'maven', id + '.cancel');
  if (fs.existsSync(cancelFile)) {
    state.status = 'cancelled';
    save();
    return inspect(opts);
  }
  save();
  const output = fs.openSync(log, 'w', 0o600);
  const child = spawn(binary, args, { cwd, detached: true, stdio: ['ignore', output, output], env });
  fs.closeSync(output);
  let timedOut = false,
    cancelled = false,
    escalation;
  const kill = (signal) => {
    if (child.pid) {
      try {
        process.kill(-child.pid, signal);
      } catch (e) {
        if (e.code !== 'ESRCH') throw e;
      }
    }
  };
  const minutes = opts.timeoutMinutes || 15;
  const timer = setTimeout(
    () => {
      timedOut = true;
      kill('SIGKILL');
    },
    minutes * 60 * 1000,
  );
  const cancellation = setInterval(() => {
    if (!cancelled && fs.existsSync(cancelFile)) {
      cancelled = true;
      kill('SIGTERM');
      escalation = setTimeout(() => kill('SIGKILL'), 3000);
    }
  }, 250);
  const terminate = () => kill('SIGTERM');
  process.on('SIGTERM', terminate);
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
  } catch {
    code = -1;
  } finally {
    if (cancelled || timedOut) kill('SIGKILL');
    clearTimeout(timer);
    clearInterval(cancellation);
    clearTimeout(escalation);
    process.off('SIGTERM', terminate);
  }
  state.status = cancelled ? 'cancelled' : code === 0 ? 'done' : 'failed';
  state.at = new Date().toISOString();
  save();
  if (cancelled) return inspect(opts);
  if (code !== 0)
    throw new Error(timedOut ? `Maven 执行超过 ${minutes} 分钟，请查看任务日志` : 'Maven 执行失败，请查看任务日志');
  return inspect(opts);
}
async function main() {
  const opts = options();
  if (action === 'cancel') {
    if (!opts.id) throw new Error('任务标识缺失');
    fs.mkdirSync(path.join(root, '.platform', 'maven'), { recursive: true });
    fs.writeFileSync(path.join(root, '.platform', 'maven', opts.id + '.cancel'), 'cancel', { mode: 0o600 });
    return { requested: true };
  }
  if (action === 'inspect') return inspect(opts);
  if (action === 'log') return logResult(opts);
  if (!Object.hasOwn(goals, action)) throw new Error('未知 Maven 操作');
  return execute(opts);
}
main()
  .then((result) => process.stdout.write(JSON.stringify(result)))
  .catch((error) => {
    process.stdout.write(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  });
