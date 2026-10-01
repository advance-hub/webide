'use strict';

// Runs inside the workspace, never in the control-plane process. Repository
// commands use the same trust boundary as typing them into its terminal.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');

const configName = '.opensumi/development.json';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const read = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
};
const json = (file) => {
  const value = read(file);
  return value ? JSON.parse(value) : null;
};
const write = (file, value) => {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
};

function loadConfig(root, service, supplied, initializing = false) {
  const project = fs.realpathSync(path.join(root, 'project'));
  const filename = path.join(project, configName);
  if (!supplied && !fs.existsSync(filename)) return null;
  if (!supplied && fs.statSync(filename).size > 32768) throw new Error(`${configName} exceeds 32 KiB`);
  let config = supplied || JSON.parse(fs.readFileSync(filename, 'utf8'));
  const services = config.services;
  let serviceIndex = 0,
    serviceName = 'default';
  if (services !== undefined) {
    if (
      !Array.isArray(services) ||
      services.length < 1 ||
      services.length > 8 ||
      config.run ||
      new Set(services.map((s) => s?.name)).size !== services.length ||
      services.some(
        (s) =>
          !s ||
          !/^[a-z][a-z0-9-]{0,31}$/.test(s.name) ||
          s.name === 'default' ||
          Object.keys(s).some((k) => !['name', 'cwd', 'command', 'port', 'healthPath', 'portMode'].includes(k)),
      )
    )
      throw new Error('services 必须包含 1–8 个名称唯一的任务，且不能同时配置 run');
    serviceIndex = service ? services.findIndex((s) => s.name === service) : 0;
    if (serviceIndex < 0) throw new Error('服务不存在');
    const selected = services[serviceIndex];
    serviceName = selected.name;
    const { name, cwd, ...run } = selected;
    config = { ...config, cwd: initializing ? config.cwd : cwd || config.cwd, run };
  }
  if (
    !config ||
    config.version !== 1 ||
    (config.cwd !== undefined && typeof config.cwd !== 'string') ||
    Object.keys(config).some((key) => !['version', 'cwd', 'init', 'run', 'services'].includes(key))
  ) {
    throw new Error(`${configName}: expected version 1 and supported fields only`);
  }
  const cwd = fs.realpathSync(path.resolve(project, config.cwd || '.'));
  if (cwd !== project && !cwd.startsWith(`${project}${path.sep}`))
    throw new Error('Development cwd must be inside the project');
  const commands = config.init || [];
  const validCommand = (value) =>
    typeof value === 'string' && value.trim().length > 0 && value.length <= 8192 && !value.includes('\0');
  if (!Array.isArray(commands) || commands.length > 16 || !commands.every(validCommand))
    throw new Error('Invalid init commands');
  if (config.run) {
    const { command, port, healthPath = '/' } = config.run;
    if (
      !validCommand(command) ||
      !Number.isInteger(port) ||
      port < 1024 ||
      port > 65535 ||
      [4317, 44772].includes(port) ||
      (port >= 12000 && port <= 12999) ||
      typeof healthPath !== 'string' ||
      !healthPath.startsWith('/') ||
      healthPath.startsWith('//') ||
      /[\r\n]/.test(healthPath) ||
      (config.run.portMode !== undefined && !['fixed', 'assigned'].includes(config.run.portMode)) ||
      Object.keys(config.run).some((key) => !['command', 'port', 'healthPath', 'portMode'].includes(key))
    )
      throw new Error('Invalid run command, port or healthPath');
    const assigned = Number(process.env.CLOUDDEV_PREVIEW_PORT);
    if (config.run.portMode !== 'fixed' && Number.isInteger(assigned) && assigned >= 22000 && assigned <= 22999) {
      config.run.port = assigned + serviceIndex * 1000;
    }
  }
  return { ...config, cwd, init: commands, serviceName };
}

function fingerprint(config) {
  const hash = crypto.createHash('sha256').update(JSON.stringify(config));
  for (const file of [
    'package.json',
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'pom.xml',
    'requirements.txt',
    'uv.lock',
    'pyproject.toml',
    'Cargo.lock',
  ]) {
    hash.update(file).update(read(path.join(config.cwd, file)));
  }
  return hash.digest('hex');
}

function ownsProcess(state) {
  if (!state || !Number.isInteger(state.pid) || state.pid <= 1 || !/^[a-f0-9]{32}$/.test(state.token || ''))
    return false;
  try {
    process.kill(state.pid, 0);
    const command =
      process.platform === 'linux'
        ? fs.readFileSync(`/proc/${state.pid}/cmdline`, 'utf8')
        : spawnSync('ps', ['-p', String(state.pid), '-o', 'command='], { encoding: 'utf8' }).stdout;
    return command.includes(__filename) && command.includes(state.token);
  } catch {
    return false;
  }
}

function platformPath(root, service = 'default') {
  return service === 'default' ? path.join(root, '.platform') : path.join(root, '.platform', 'services', service);
}
async function stop(root, service) {
  if (!service) {
    await stop(root, 'default');
    const dir = path.join(root, '.platform', 'services');
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : [])
      if (/^[a-z][a-z0-9-]{0,31}$/.test(name)) await stop(root, name);
    return { configured: false };
  }
  const statePath = path.join(platformPath(root, service), 'development-process.json');
  const state = json(statePath);
  if (ownsProcess(state)) {
    try {
      process.kill(-state.pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
    for (let i = 0; i < 30 && ownsProcess(state); i++) await wait(100);
    if (ownsProcess(state)) {
      try {
        process.kill(-state.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
  }
  fs.rmSync(statePath, { force: true });
  return { configured: false };
}

function command(commandText, cwd, log, budget) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', commandText], { cwd, detached: true, stdio: ['ignore', log, log] });
    const timeout = setTimeout(
      () => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
      },
      Math.max(1, budget),
    );
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`Initialization failed (${signal || code}); see .platform/development.log`));
    });
  });
}

async function probe(port, healthPath) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${healthPath}`, {
      signal: AbortSignal.timeout(1000),
      redirect: 'manual',
    });
    await response.body?.cancel();
    return response.status >= 200 && response.status < 400;
  } catch {
    return false;
  }
}

async function run(root, phase, service) {
  if (!['initialize', 'start'].includes(phase)) throw new Error('Unknown development phase');
  const config = loadConfig(root, service, undefined, phase === 'initialize');
  if (!config)
    return { configured: false, ready: false, message: `IDE ready; add ${configName} to automate project startup` };
  const platform = phase === 'initialize' ? path.join(root, '.platform') : platformPath(root, config.serviceName);
  fs.mkdirSync(platform, { recursive: true });
  const digest = fingerprint(config);
  if (phase === 'initialize') {
    const marker = path.join(platform, 'development-init.json');
    if (json(marker)?.fingerprint === digest) return { configured: true, cached: true };
    const logfile = path.join(platform, 'development.log');
    if (fs.existsSync(logfile) && fs.statSync(logfile).size > 5 * 1024 * 1024)
      fs.renameSync(logfile, `${logfile}.previous`);
    const log = fs.openSync(logfile, 'a', 0o600);
    const deadline = Date.now() + 4 * 60 * 1000;
    try {
      for (const item of config.init) {
        if (Date.now() >= deadline) throw new Error('Initialization timed out; see .platform/development.log');
        await command(item, config.cwd, log, deadline - Date.now());
      }
    } finally {
      fs.closeSync(log);
    }
    // A command may update a lockfile. Record the actual successful output state.
    write(marker, { fingerprint: fingerprint(config), at: new Date().toISOString() });
    return { configured: true, cached: false };
  }
  if (!config.run)
    return {
      configured: true,
      ready: false,
      message: 'Initialization complete; no application run command configured',
    };
  const statePath = path.join(platform, 'development-process.json');
  let state = json(statePath);
  if (!ownsProcess(state) || state.fingerprint !== digest) {
    await stop(root, config.serviceName);
    if (await occupied(config.run.port))
      throw new Error('预览端口已被其他项目占用；请使用分配的 PORT 环境变量，或调整 run.port');
    const token = crypto.randomBytes(16).toString('hex');
    const jobPath = path.join(platform, `development-job-${token}.json`);
    write(jobPath, { command: config.run.command, cwd: config.cwd, port: config.run.port });
    const log = fs.openSync(path.join(platform, 'development.log'), 'a', 0o600);
    const child = spawn(process.execPath, [__filename, 'serve', root, token, config.serviceName], {
      detached: true,
      stdio: ['ignore', log, log],
    });
    fs.closeSync(log);
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
    state = { pid: child.pid, token, fingerprint: digest, port: config.run.port };
    write(statePath, state);
  }
  for (let attempt = 0; attempt < 60; attempt++) {
    if (!ownsProcess(state)) throw new Error('Application exited; see .platform/development.log');
    if (await probe(config.run.port, config.run.healthPath || '/'))
      return { configured: true, ready: true, port: config.run.port, healthPath: config.run.healthPath || '/' };
    await wait(500);
  }
  throw new Error('Application health check timed out; see .platform/development.log');
}

function occupied(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1000, () => done(true));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function inspect(root, runtimeRoot) {
  const required = ['server/dist/main.js', 'builtin-extensions.manifest.json'];
  for (const file of required)
    if (!fs.statSync(path.join(runtimeRoot, file)).isFile()) throw new Error(`Development image missing ${file}`);
  for (const tool of ['git', 'zsh']) {
    if (spawnSync(tool, ['--version'], { stdio: 'ignore' }).status !== 0)
      throw new Error(`Development image missing executable ${tool}`);
  }
  const index = json(path.join(runtimeRoot, 'builtin-extensions.manifest.json'));
  if (index?.version !== 1 || !index.localeFiles || !Object.keys(index.localeFiles).length)
    throw new Error('Invalid builtin extension manifest');
  for (const file of Object.values(index.localeFiles)) {
    if (typeof file !== 'string' || path.isAbsolute(file) || file.split(/[\\/]/).includes('..'))
      throw new Error('Invalid extension shard path');
    if (!fs.statSync(path.join(runtimeRoot, file)).isFile()) throw new Error('Missing extension shard');
  }
  fs.mkdirSync(path.join(root, '.platform'), { recursive: true });
  fs.accessSync(root, fs.constants.W_OK);
  return {
    fingerprint: crypto
      .createHash('sha256')
      .update(read(path.join(runtimeRoot, 'server/dist/main.js')))
      .update(read(path.join(runtimeRoot, 'builtin-extensions.manifest.json')))
      .digest('hex'),
    node: process.version,
    architecture: process.arch,
  };
}

async function main() {
  const [phase, suppliedRoot = '/workspace', argument = '/app'] = process.argv.slice(2);
  const root = path.resolve(suppliedRoot);
  if (phase === 'serve') {
    if (!/^[a-f0-9]{32}$/.test(argument)) throw new Error('Invalid service token');
    const jobPath = path.join(platformPath(root, process.argv[5] || 'default'), `development-job-${argument}.json`);
    const job = json(jobPath);
    fs.rmSync(jobPath, { force: true });
    const child = spawn('/bin/sh', ['-c', job.command], {
      cwd: job.cwd,
      env: { ...process.env, PORT: String(job.port), SERVER_PORT: String(job.port) },
      stdio: 'inherit',
    });
    child.on('exit', (code) => process.exit(code || 0));
    child.on('error', () => process.exit(1));
    return;
  }
  const result =
    phase === 'inspect'
      ? inspect(root, argument)
      : phase === 'stop'
        ? await stop(root)
        : phase === 'start'
          ? await startAll(root)
          : await run(root, phase);
  process.stdout.write(JSON.stringify(result));
}
async function services(root) {
  const config = loadConfig(root);
  if (!config) return { configured: false, ready: false, services: [] };
  const names = config.services ? config.services.map((s) => s?.name) : config.run ? ['default'] : [];
  const rows = [];
  for (const name of names) {
    const item = loadConfig(root, name === 'default' ? undefined : name);
    const state = json(path.join(platformPath(root, name), 'development-process.json'));
    const running = ownsProcess(state),
      ready = running && (await probe(item.run.port, item.run.healthPath || '/'));
    rows.push({
      name,
      port: item.run.port,
      healthPath: item.run.healthPath || '/',
      ready,
      running,
      error: !running ? '尚未运行' : !ready ? '健康检查未通过' : '',
    });
  }
  return {
    configured: true,
    ready: rows.some((s) => s.ready),
    port: rows.find((s) => s.ready)?.port || rows[0]?.port,
    healthPath: rows.find((s) => s.ready)?.healthPath || '/',
    services: rows,
  };
}
async function startAll(root) {
  const config = loadConfig(root);
  if (!config?.services) return run(root, 'start');
  const failures = {};
  for (const service of config.services) {
    try {
      await run(root, 'start', service.name);
    } catch (e) {
      failures[service.name] = e.message;
    }
  }
  const report = await services(root);
  for (const service of report.services) if (failures[service.name]) service.error = failures[service.name];
  if (Object.keys(failures).length) report.error = '部分任务启动失败，请查看各自日志';
  return report;
}
module.exports = { loadConfig, fingerprint, run, stop, inspect, services, platformPath, startAll };
if (require.main === module)
  main().catch((error) => {
    process.stdout.write(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  });
