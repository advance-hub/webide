import type { Workspace } from './models';

export const mavenKey = (workspace: Workspace): string => `maven:${workspace.machineId || workspace.id}`;
