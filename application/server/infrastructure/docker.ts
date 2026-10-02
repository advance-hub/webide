import { type Config } from '../platform/config';
import { command } from '../platform/process';
import { HTTPError, requireString } from '../platform/validation';

interface ImageInspection {
  Id: string;
  RepoTags?: string[];
  Size: number;
  Created: string;
}

export class DockerEngine {
  constructor(readonly config: Config) {}
  private run(args: string[]): Promise<string> {
    return command(
      'docker',
      [...(this.config.dockerContext ? ['--context', this.config.dockerContext] : []), ...args],
      { timeout: 30000 },
    );
  }

  async images(): Promise<{ id: string; tags: string[]; size: number; createdAt: string; inUse: number }[]> {
    const ids = [...new Set((await this.run(['image', 'ls', '--quiet', '--no-trunc'])).split(/\s+/).filter(Boolean))];
    if (!ids.length) {
      return [];
    }
    const images: ImageInspection[] = [];
    for (let index = 0; index < ids.length; index += 100) {
      images.push(
        ...(JSON.parse(await this.run(['image', 'inspect', ...ids.slice(index, index + 100)])) as ImageInspection[]),
      );
    }
    return images
      .filter((image) => image.RepoTags?.length)
      .map((image) => ({
        id: image.Id.replace(/^sha256:/, '').slice(0, 12),
        tags: image.RepoTags!,
        size: image.Size,
        createdAt: image.Created || '',
        inUse: 0,
      }))
      .sort((first, second) => second.createdAt.localeCompare(first.createdAt));
  }

  async removeImage(value: unknown): Promise<void> {
    const reference = requireString(value, '镜像名称', 512);
    if (reference.startsWith('-') || /\s/.test(reference)) {
      throw new HTTPError(400, '镜像名称无效');
    }
    await this.run(['image', 'rm', '--', reference]);
  }

  async removeMachineVolume(machineId: string): Promise<void> {
    if (!/^[a-f0-9]{32}$/.test(machineId)) {
      throw new HTTPError(400, '开发机标识无效');
    }
    const name = `opensumi-${machineId}`;
    const volumes = (await this.run(['volume', 'ls', '--format', '{{.Name}}', '--filter', `name=^${name}$`])).split(
      '\n',
    );
    if (volumes.includes(name)) {
      const attached = (await this.run(['container', 'ls', '--all', '--quiet', '--filter', `volume=${name}`])).trim();
      if (attached) {
        throw new HTTPError(409, '持久卷仍被容器引用，保留卷等待处理');
      }
      await this.run(['volume', 'rm', '--', name]);
    }
  }
}
