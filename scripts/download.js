'use strict';

const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');

const { expectedExtensions, receiptPath, verifyExtension, verifyExtensions } = require('./verify-extensions.cjs');

const registry = (process.env.OPENVSX_REGISTRY || 'https://open-vsx.org').replace(/\/$/, '');
const targetDir = path.resolve(process.env.OPENSUMI_EXTENSION_DIR || path.join(__dirname, '../tools/extensions'));
const targetPlatform = process.env.OPENSUMI_EXTENSION_PLATFORM || `${process.platform}-${process.arch}`;

async function archiveHash(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function downloadArchive(url, archive, checksum) {
  await fsp.mkdir(path.dirname(archive), { recursive: true });
  if (fs.existsSync(archive) && (await archiveHash(archive)) === checksum) {
    return;
  }
  // 跨重试和多次执行保留未完成的下载包；curl 的 HTTP/1.1 分段下载
  // 支持官方 CDN，且不需要将大型 Java VSIX 全部缓存在内存中。
  await promisify(execFile)(
    'curl',
    [
      '--fail',
      '--location',
      '--http1.1',
      '--silent',
      '--show-error',
      '--connect-timeout',
      '15',
      '--max-time',
      '600',
      '--continue-at',
      '-',
      '--output',
      archive,
      '--url',
      url,
    ],
    { timeout: 615000, maxBuffer: 65536 },
  );
  if ((await archiveHash(archive)) !== checksum) {
    await fsp.rm(archive, { force: true });
    throw new Error('Extension checksum mismatch');
  }
}

async function request(url, timeout = 120_000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Extension download HTTP ${response.status}: ${url}`);
  }
  return response;
}

function selectPlatform(metadata, platform) {
  if (metadata.downloads?.[platform]) {
    return platform;
  }
  if (metadata.downloads?.universal) {
    return 'universal';
  }
  throw new Error(`No extension artifact for ${platform}: ${metadata.namespace}.${metadata.name}`);
}

async function installExtension(extension) {
  const id = `${extension.publisher}.${extension.name}-${extension.version}`;
  const destination = path.join(targetDir, id);
  try {
    verifyExtension(destination, extension, targetPlatform);
    console.log(`Extension ready: ${id}`);
    return;
  } catch {
    // 下载成功后只替换当前固定版本的扩展。
    // 保留其他扩展，下载失败时继续保留旧版本。
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    const staging = await fsp.mkdtemp(path.join(path.dirname(targetDir), '.opensumi-extension-'));
    try {
      const apiPath = `${registry}/api/${extension.publisher}/${extension.name}`;
      let metadata = await (await request(`${apiPath}/${extension.version}`)).json();
      const platform = selectPlatform(metadata, targetPlatform);
      if (metadata.targetPlatform !== platform) {
        metadata = await (await request(`${apiPath}/${platform}/${extension.version}`)).json();
      }
      if (metadata.version !== extension.version || !metadata.files?.download || !metadata.files?.sha256) {
        throw new Error(`Incomplete pinned extension metadata: ${id}`);
      }
      const checksum = (await (await request(metadata.files.sha256)).text()).trim().split(/\s+/)[0];
      if (!/^[a-f0-9]{64}$/i.test(checksum)) {
        throw new Error(`Invalid SHA256 for ${id}`);
      }
      const archive = path.join(__dirname, '../.cache/extension-downloads', `${id}-${platform}-${checksum}.vsix`);
      await downloadArchive(metadata.files.download, archive, checksum.toLowerCase());
      await promisify(execFile)('unzip', ['-q', archive, '-d', staging], { timeout: 120_000 });
      const unpacked = path.join(staging, 'extension');
      // 将下载凭据放在第三方目录之外，避免干扰扩展激活时
      // 对自身文件清单的校验。
      const receipt = { platform, sha256: checksum };
      await fsp.writeFile(receiptPath(unpacked), JSON.stringify(receipt));
      verifyExtension(unpacked, extension, targetPlatform, receipt);
      const backup = path.join(staging, 'previous');
      const hadPrevious = fs.existsSync(destination);
      if (hadPrevious) {
        await fsp.rename(destination, backup);
      }
      let installed = false;
      try {
        await fsp.rename(unpacked, destination);
        installed = true;
        await fsp.rename(receiptPath(unpacked), receiptPath(destination));
      } catch (error) {
        if (installed) {
          await fsp.rm(destination, { recursive: true, force: true });
        }
        if (hadPrevious) {
          await fsp.rename(backup, destination);
        }
        throw error;
      }
      console.log(`Extension installed: ${id} (${platform})`);
      await fsp.rm(archive, { force: true });
      return;
    } catch (error) {
      if (attempt === 3) {
        throw new Error(`Cannot install ${id}: ${error.message}`, { cause: error });
      }
      console.warn(`Retry extension ${id} (${attempt}/3): ${error.message}`);
    } finally {
      await fsp.rm(staging, { recursive: true, force: true });
    }
  }
}

async function main() {
  await fsp.mkdir(targetDir, { recursive: true });
  const queue = [...expectedExtensions()];
  const results = await Promise.allSettled(
    Array.from({ length: 3 }, async () => {
      while (queue.length) {
        await installExtension(queue.shift());
      }
    }),
  );
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length) {
    throw new AggregateError(
      failures.map((result) => result.reason),
      'Builtin extension installation failed',
    );
  }
  verifyExtensions(targetDir, targetPlatform);
  await retireSupersededExtensions(targetDir, expectedExtensions());
}

// 扫描器读取所有目录；如果不兼容的新版本和固定的旧版本
// 同时存在，启动时可能选择错误的版本。
async function retireSupersededExtensions(directory, expected) {
  const wanted = new Map(expected.map((e) => [`${e.publisher}.${e.name}`.toLowerCase(), e.version]));
  let backup;
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const location = path.join(directory, entry.name);
    if (!fs.existsSync(receiptPath(location))) {
      continue;
    } // 不修改用户自行管理的目录。
    let manifest;
    try {
      manifest = JSON.parse(await fsp.readFile(path.join(location, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    if (!manifest.publisher || !manifest.name || !manifest.version) {
      continue;
    }
    const id = `${manifest.publisher}.${manifest.name}`;
    if (wanted.get(id.toLowerCase()) === manifest.version) {
      continue;
    }
    backup ||= await fsp.mkdtemp(path.join(path.dirname(directory), '.opensumi-retired-'));
    await fsp.rename(location, path.join(backup, entry.name));
    await fsp.rename(receiptPath(location), receiptPath(path.join(backup, entry.name)));
    console.log(`Extension superseded: ${id}-${manifest.version}`);
  }
}

module.exports = { selectPlatform, retireSupersededExtensions };
if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
