/* eslint-disable @typescript-eslint/ban-ts-comment */
import path from 'path';

import { Autowired, INJECTOR_TOKEN, Injectable, Injector, Optional } from '@opensumi/di';
import { CLIENT_ID_TOKEN, Uri } from '@opensumi/ide-core-common';
import { INodeLogger } from '@opensumi/ide-core-node/logger';
import { IFileService } from '@opensumi/ide-file-service';

import { IExtensionHostProfilerService } from '../common';

import {
  ExtensionHostProfilerCoordinator,
  type ExtensionHostProfilerStopResult,
} from './extension-host-profiler-coordinator';

import type { Profile, ProfilingSession } from 'v8-inspect-profiler';

export enum ProfileSessionState {
  None = 0,
  Starting = 1,
  Running = 2,
  Stopping = 3,
}

export const EXTENSION_PROFILER_LIFECYCLE_OPTIONS = Symbol('ExtensionProfilerLifecycleOptions');
export const DEFAULT_EXTENSION_PROFILER_CLEANUP_LEASE_MS = 5_000;
export const EXTENSION_PROFILER_CLEANUP_STOP_ATTEMPTS = 2;
export const EXTENSION_PROFILER_START_GENERATION_ATTEMPTS = 3;

export interface ExtensionProfilerLifecycleOptions {
  cleanupLeaseMs?: number;
  startProfiler?: (inspectPort: number) => Promise<ProfilingSession>;
}

const EXTENSION_PROFILER_IDENTITY_ERROR = 'Extension profiler session identity is invalid';
const EXTENSION_PROFILER_LIFECYCLE_ERROR = 'Extension profiler session lifecycle is unavailable';
const EXTENSION_PROFILE_PATH_ERROR = 'Extension profile save path is invalid';
const EXTENSION_PROFILE_SAVE_ERROR = 'Extension profile could not be saved';

interface ProfilerLifecycle {
  cleanupLeaseMs: number;
  cleanupPromise?: Promise<void>;
  cleanupRegistered: boolean;
  disposed: boolean;
  startProfiler: (inspectPort: number) => Promise<ProfilingSession>;
  startPromise?: Promise<void>;
  stopPromise?: Promise<ExtensionHostProfilerStopResult>;
}

function normalizeCleanupLeaseMs(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_EXTENSION_PROFILER_CLEANUP_LEASE_MS;
  }
  return Math.max(1, Math.floor(value));
}

function safeLogError(logger: INodeLogger, message: string, reason?: unknown): void {
  try {
    if (reason === undefined) {
      logger.error(message);
    } else {
      logger.error(message, reason);
    }
  } catch {
    // Logging must remain best-effort while the connection injector is torn down.
  }
}

function requireBoundClientId(boundClientId: string, requestedClientId: string): string {
  if (
    typeof boundClientId !== 'string' ||
    boundClientId.trim().length === 0 ||
    typeof requestedClientId !== 'string' ||
    requestedClientId !== boundClientId
  ) {
    throw new Error(EXTENSION_PROFILER_IDENTITY_ERROR);
  }
  return boundClientId;
}

function assertProfilerLifecycleActive(lifecycle: ProfilerLifecycle): void {
  if (lifecycle.disposed) {
    throw new Error(EXTENSION_PROFILER_LIFECYCLE_ERROR);
  }
}

async function doStartProfiler(port: number): Promise<ProfilingSession> {
  // @ts-ignore v8-inspect-profiler has no declaration compatible with this package target.
  const profiler = await import('v8-inspect-profiler');
  const session = await profiler.startProfiling({ port, checkForPaused: true });
  return {
    stop: async () => {
      const profile = await session.stop();
      return profile;
    },
  };
}

function registerProfilerCleanup(
  owner: ExtensionProfilerService,
  injector: Injector,
  lifecycle: ProfilerLifecycle,
  coordinator: ExtensionHostProfilerCoordinator,
  authority: object,
  clientId: string,
  logger: INodeLogger,
): void {
  if (lifecycle.cleanupRegistered) {
    return;
  }
  const dispose = () => {
    lifecycle.disposed = true;
    if (!lifecycle.cleanupPromise) {
      lifecycle.cleanupPromise = coordinator.release(authority, clientId, lifecycle.cleanupLeaseMs);
    }
    return lifecycle.cleanupPromise;
  };
  const unregister = injector.onceInstanceDisposed(owner, () => {
    const cleanupPromise = dispose();
    void cleanupPromise.catch((reason) => {
      safeLogError(logger, 'Failed to clean up one or more extension profiling sessions.', reason);
    });
  });
  if (!unregister) {
    throw new Error(EXTENSION_PROFILER_LIFECYCLE_ERROR);
  }
  try {
    injector.addProviders({
      token: Symbol('ExtensionProfilerConnectionScopeCleanup'),
      useValue: { dispose },
    });
  } catch {
    unregister();
    throw new Error(EXTENSION_PROFILER_LIFECYCLE_ERROR);
  }
  lifecycle.cleanupRegistered = true;
}

function toProfileFileUri(savePath: string): string {
  if (typeof savePath !== 'string' || savePath.trim().length === 0 || !path.isAbsolute(savePath)) {
    throw new Error(EXTENSION_PROFILE_PATH_ERROR);
  }
  const uri = Uri.file(savePath);
  if (uri.scheme !== 'file') {
    throw new Error(EXTENSION_PROFILE_PATH_ERROR);
  }
  return uri.toString();
}

@Injectable()
export class ExtensionProfilerService implements IExtensionHostProfilerService {
  @Autowired(CLIENT_ID_TOKEN)
  private readonly clientId: string;

  @Autowired(INJECTOR_TOKEN)
  private readonly injector: Injector;

  @Autowired(IFileService)
  private readonly fileService: IFileService;

  @Autowired(INodeLogger)
  private readonly logger: INodeLogger;

  @Autowired(ExtensionHostProfilerCoordinator)
  private readonly coordinator: ExtensionHostProfilerCoordinator;

  private readonly authority = Object.freeze({});
  private readonly lifecycle: ProfilerLifecycle;

  /** Compatibility-only test projection. The root coordinator remains the owner. */
  private get sessionMap(): Map<string, unknown> {
    return this.coordinator.getSessionMap();
  }

  /** Compatibility-only test projection. Production persistence uses versioned coordinator CAS. */
  private get lastProfile(): Profile | null {
    return this.coordinator.peekLastProfile(this.clientId)?.profile ?? null;
  }

  private set lastProfile(profile: Profile | null) {
    this.coordinator.setLastProfile(this.clientId, profile);
  }

  constructor(@Optional(EXTENSION_PROFILER_LIFECYCLE_OPTIONS) options?: ExtensionProfilerLifecycleOptions) {
    this.lifecycle = {
      cleanupLeaseMs: normalizeCleanupLeaseMs(options?.cleanupLeaseMs),
      cleanupRegistered: false,
      disposed: false,
      startProfiler: options?.startProfiler ?? doStartProfiler,
    };
  }

  async $startProfile(clientId: string): Promise<void> {
    assertProfilerLifecycleActive(this.lifecycle);
    const boundClientId = requireBoundClientId(this.clientId, clientId);
    registerProfilerCleanup(
      this,
      this.injector,
      this.lifecycle,
      this.coordinator,
      this.authority,
      boundClientId,
      this.logger,
    );
    assertProfilerLifecycleActive(this.lifecycle);

    const pendingStop = this.lifecycle.stopPromise;
    if (pendingStop) {
      await Promise.allSettled([pendingStop]);
      assertProfilerLifecycleActive(this.lifecycle);
    }
    if (!this.lifecycle.startPromise) {
      this.lifecycle.startPromise = this.coordinator.start(this.authority, boundClientId, {
        cleanupLeaseMs: this.lifecycle.cleanupLeaseMs,
        startProfiler: this.lifecycle.startProfiler,
      });
    }
    const startPromise = this.lifecycle.startPromise;
    try {
      await startPromise;
      assertProfilerLifecycleActive(this.lifecycle);
    } catch (error) {
      if (this.lifecycle.disposed) {
        throw new Error(EXTENSION_PROFILER_LIFECYCLE_ERROR, { cause: error });
      }
      throw error;
    } finally {
      if (this.lifecycle.startPromise === startPromise) {
        this.lifecycle.startPromise = undefined;
      }
    }
  }

  async $stopProfile(clientId: string): Promise<boolean> {
    assertProfilerLifecycleActive(this.lifecycle);
    const boundClientId = requireBoundClientId(this.clientId, clientId);
    registerProfilerCleanup(
      this,
      this.injector,
      this.lifecycle,
      this.coordinator,
      this.authority,
      boundClientId,
      this.logger,
    );
    assertProfilerLifecycleActive(this.lifecycle);

    const pendingStart = this.lifecycle.startPromise;
    if (pendingStart) {
      await pendingStart;
      assertProfilerLifecycleActive(this.lifecycle);
    }
    if (!this.lifecycle.stopPromise) {
      this.lifecycle.stopPromise = this.coordinator.stop(this.authority, boundClientId);
    }
    const stopPromise = this.lifecycle.stopPromise;
    try {
      const result = await stopPromise;
      assertProfilerLifecycleActive(this.lifecycle);
      if (!result.stopped) {
        this.logger.verbose('No profiling session found for the current extension session.');
        return false;
      }
      this.logger.verbose('Stopped the current extension profiling session.');
      return true;
    } catch (error) {
      if (this.lifecycle.disposed) {
        throw new Error(EXTENSION_PROFILER_LIFECYCLE_ERROR, { cause: error });
      }
      safeLogError(this.logger, 'Stop profiling session failed.', error);
      return false;
    } finally {
      if (this.lifecycle.stopPromise === stopPromise) {
        this.lifecycle.stopPromise = undefined;
      }
    }
  }

  async $saveLastProfile(savePath: string): Promise<void> {
    assertProfilerLifecycleActive(this.lifecycle);
    const boundClientId = requireBoundClientId(this.clientId, this.clientId);
    registerProfilerCleanup(
      this,
      this.injector,
      this.lifecycle,
      this.coordinator,
      this.authority,
      boundClientId,
      this.logger,
    );
    assertProfilerLifecycleActive(this.lifecycle);

    const uri = toProfileFileUri(savePath);
    const storedProfile = this.coordinator.peekLastProfile(boundClientId);
    const content = JSON.stringify(storedProfile?.profile ?? {}, null, '\t');
    try {
      const stat = await this.fileService.getFileStat(uri);
      if (stat) {
        await this.fileService.setContent(stat, content);
      } else {
        await this.fileService.createFile(uri, { content });
      }
    } catch {
      this.logger.error('Failed to save the last extension profile.');
      throw new Error(EXTENSION_PROFILE_SAVE_ERROR);
    }
    assertProfilerLifecycleActive(this.lifecycle);
    if (storedProfile) {
      this.coordinator.consumeLastProfile(boundClientId, storedProfile.version);
    }
  }
}
