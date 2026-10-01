import { PreferenceService } from '@opensumi/ide-core-browser';
import { ACPAgentType, AINativeSettingSectionsId, AgentConfig, DEFAULT_AGENT_TYPE } from '@opensumi/ide-core-common';

export const DEFAULT_AGENT_CONFIGS: Record<string, AgentConfig> = {
  qwen: {
    command: 'qwen',
    args: ['--acp', '--channel=ACP', '--input-format=stream-json', '--output-format=stream-json'],
    streaming: true,
    description: 'Qwen CLI Agent',
  },
  'claude-agent-acp': {
    command: 'claude-agent-acp',
    args: [],
    streaming: true,
    description: 'Claude Code ACP Agent',
  },
};

function getUserAgentConfigs(preferenceService: PreferenceService): Record<string, AgentConfig> {
  const configs = preferenceService.get<Record<string, AgentConfig>>(AINativeSettingSectionsId.AgentConfigs, {});
  return configs && typeof configs === 'object' && !Array.isArray(configs) ? configs : {};
}

function hasCommand(config: AgentConfig | undefined): config is AgentConfig {
  return typeof config?.command === 'string' && config.command.trim().length > 0;
}

export function getConfiguredAgentConfigs(preferenceService: PreferenceService): Record<string, AgentConfig> {
  return Object.fromEntries(
    Object.entries(getUserAgentConfigs(preferenceService)).filter(([, config]) => hasCommand(config)),
  );
}

export function getAvailableAgentConfigs(preferenceService: PreferenceService): Record<string, AgentConfig> {
  const userConfigs = getUserAgentConfigs(preferenceService);
  if (preferenceService.get<boolean>(AINativeSettingSectionsId.AgentBuiltInsEnabled, true) === false) {
    return getConfiguredAgentConfigs(preferenceService);
  }
  const mergedConfigs: Record<string, AgentConfig> = {};

  for (const [agentType, defaultConfig] of Object.entries(DEFAULT_AGENT_CONFIGS)) {
    const mergedConfig = {
      ...defaultConfig,
      ...(userConfigs[agentType] || {}),
    };
    mergedConfigs[agentType] = hasCommand(mergedConfig) ? mergedConfig : defaultConfig;
  }

  for (const [agentType, config] of Object.entries(userConfigs)) {
    if (!mergedConfigs[agentType] && hasCommand(config)) {
      mergedConfigs[agentType] = config;
    }
  }

  return mergedConfigs;
}

/**
 * Get the default agent type from user preferences
 */
export function getDefaultAgentType(preferenceService: PreferenceService): ACPAgentType {
  const agentType = preferenceService.get<ACPAgentType>(AINativeSettingSectionsId.DefaultAgentType, DEFAULT_AGENT_TYPE);
  const configs = getAvailableAgentConfigs(preferenceService);
  if (configs[agentType]) {
    return agentType;
  }
  return configs[DEFAULT_AGENT_TYPE] ? DEFAULT_AGENT_TYPE : Object.keys(configs)[0] || DEFAULT_AGENT_TYPE;
}

/**
 * Get agent config (command + args) for a given type, preferring user preferences over defaults
 */
export function getAgentConfig(preferenceService: PreferenceService, agentType: ACPAgentType): AgentConfig {
  const configs = getAvailableAgentConfigs(preferenceService);
  return configs[agentType] || DEFAULT_AGENT_CONFIGS[DEFAULT_AGENT_TYPE];
}
