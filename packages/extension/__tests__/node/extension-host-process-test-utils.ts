import { ExtensionHostProcessLease } from '../../src/common';
import {
  ExtensionHostProcessRegistration,
  IExtensionHostProcessLeaseManager,
} from '../../src/node/extension-host-process-manager';

let nextLeaseId = 1;

export interface TestExtensionHostProcessRegistration extends ExtensionHostProcessRegistration {
  readonly activate: jest.Mock<void, []>;
  readonly discard: jest.Mock<void, []>;
}

export function createTestProcessRegistration(
  pid: number,
  managerEpoch = 1,
  leaseId = nextLeaseId++,
): TestExtensionHostProcessRegistration {
  const lease: ExtensionHostProcessLease = Object.freeze({ managerEpoch, pid, leaseId });
  return {
    lease,
    activate: jest.fn(),
    discard: jest.fn(),
  };
}

function rejectLegacyPidOperation(operation: string): jest.Mock<never, any[]> {
  return jest.fn(() => {
    throw new Error(`Legacy PID operation ${operation} must not be used`);
  });
}

export function createTestProcessLeaseManager() {
  return {
    processLeaseVersion: 1 as const,
    processControlLocation: 'local' as const,
    init: jest.fn(),
    fork: rejectLegacyPidOperation('fork'),
    send: rejectLegacyPidOperation('send'),
    isRunning: rejectLegacyPidOperation('isRunning'),
    treeKill: rejectLegacyPidOperation('treeKill'),
    kill: rejectLegacyPidOperation('kill'),
    isKilled: rejectLegacyPidOperation('isKilled'),
    findDebugPort: jest.fn(),
    onOutput: rejectLegacyPidOperation('onOutput'),
    onExit: rejectLegacyPidOperation('onExit'),
    onMessage: rejectLegacyPidOperation('onMessage'),
    disposeProcess: rejectLegacyPidOperation('disposeProcess'),
    dispose: jest.fn().mockResolvedValue(undefined),
    forkWithLease: jest.fn(),
    sendLease: jest.fn().mockResolvedValue(undefined),
    isRunningLease: jest.fn().mockResolvedValue(false),
    treeKillLease: jest.fn().mockResolvedValue(undefined),
    killLease: jest.fn().mockResolvedValue(undefined),
    isKilledLease: jest.fn().mockReturnValue(false),
    onOutputLease: jest.fn().mockReturnValue({ dispose: jest.fn() }),
    onExitLease: jest.fn().mockReturnValue({ dispose: jest.fn() }),
    onMessageLease: jest.fn().mockReturnValue({ dispose: jest.fn() }),
    disposeLease: jest.fn().mockResolvedValue(undefined),
  } satisfies IExtensionHostProcessLeaseManager;
}
