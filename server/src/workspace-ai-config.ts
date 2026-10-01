import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type Koa from 'koa';

interface AIConfig {
  model?: string;
  [key: string]: unknown;
}

export interface WorkspaceAIConfigOptions {
  home: string;
  workspaceId: string;
}

const MODEL_PATTERN = /^[^\s/#]+\/[^\s#]+$/;

function configPath(home: string): string {
  return path.join(home, '.config/opencode/opencode.json');
}

function revision(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

async function readConfig(home: string): Promise<{ config: AIConfig; revision: string }> {
  let source: string;
  try {
    source = await readFile(configPath(home), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    source = '{}';
  }
  const config: unknown = JSON.parse(source);
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('OpenCode 配置文件格式无效');
  }
  return { config: config as AIConfig, revision: revision(source) };
}

async function connectedProviders(home: string): Promise<string[]> {
  try {
    const source = await readFile(path.join(home, '.local/share/opencode/auth.json'), 'utf8');
    const auth: unknown = JSON.parse(source);
    if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
      return [];
    }
    // Return provider names only. The credential values must never reach the browser.
    return Object.keys(auth)
      .filter((id) => /^[a-zA-Z0-9._-]+$/.test(id))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function readBody(request: NodeJS.ReadableStream): Promise<unknown> {
  let source = '';
  for await (const chunk of request) {
    source += chunk.toString();
    if (source.length > 4096) {
      throw new Error('请求内容过长');
    }
  }
  return JSON.parse(source);
}

export function createWorkspaceAIConfigMiddleware({ home, workspaceId }: WorkspaceAIConfigOptions): Koa.Middleware {
  return async (context, next) => {
    if (context.path !== '/__ide/ai/config') {
      return next();
    }
    context.set('Cache-Control', 'no-store');
    // The control plane authenticates the user and supplies the workspace ID.
    // Require that proxy header so direct requests to the IDE cannot use this API.
    if (!workspaceId || context.get('x-workspace-id') !== workspaceId) {
      context.status = 403;
      context.body = { error: '工作区身份不匹配' };
      return;
    }
    if (context.method !== 'GET' && context.method !== 'POST') {
      context.status = 405;
      return;
    }
    if (
      context.method === 'POST' &&
      (context.get('origin') !== context.get('x-workspace-origin') || !context.is('application/json'))
    ) {
      context.status = 403;
      context.body = { error: '请求来源或格式无效' };
      return;
    }
    try {
      if (context.method === 'GET') {
        const [{ config, revision: currentRevision }, providers] = await Promise.all([
          readConfig(home),
          connectedProviders(home),
        ]);
        context.body = {
          model: typeof config.model === 'string' ? config.model : '',
          revision: currentRevision,
          connectedProviders: providers,
        };
        return;
      }
      const payload = (await readBody(context.req)) as { model?: unknown; revision?: unknown };
      if (
        !payload ||
        typeof payload !== 'object' ||
        typeof payload.model !== 'string' ||
        typeof payload.revision !== 'string' ||
        (payload.model !== '' && !MODEL_PATTERN.test(payload.model))
      ) {
        context.status = 400;
        context.body = { error: '模型 ID 应为 provider/model 格式，或留空使用 OpenCode 默认模型' };
        return;
      }
      const current = await readConfig(home);
      if (payload.revision !== current.revision) {
        context.status = 409;
        context.body = { error: '配置已在其他位置修改，请刷新后重试' };
        return;
      }
      if (payload.model) {
        current.config.model = payload.model;
      } else {
        delete current.config.model;
      }
      const destination = configPath(home);
      const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
      const source = `${JSON.stringify(current.config, null, 2)}\n`;
      await writeFile(temporary, source, { mode: 0o600 });
      try {
        await rename(temporary, destination);
      } catch (error) {
        const { unlink } = await import('node:fs/promises');
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
      context.body = { model: payload.model, revision: revision(source) };
    } catch (error) {
      context.status = 500;
      context.body = {
        error:
          error instanceof SyntaxError
            ? 'OpenCode 配置文件不是有效 JSON'
            : error instanceof Error
              ? error.message
              : 'AI 配置读取失败',
      };
    }
  };
}
