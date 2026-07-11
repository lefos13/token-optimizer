import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type {
  ConfigLayers,
  EffectiveConfig,
  ExecutionProfile,
  ProviderMode,
  TokenOptimizerConfig,
} from './types';

/* Configuration is intentionally layered and conservative: lower-trust project and
 * tool inputs may narrow behavior, but cannot widen a user-selected safety ceiling. */
const configSchema = z.object({
  provider: z.object({
    mode: z.enum(['local', 'gateway-token', 'gateway-byok', 'openrouter-direct']).optional(),
    apiUrl: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
  }).partial().optional(),
  execution: z.object({
    profile: z.enum(['safe', 'standard', 'unrestricted']).optional(),
    allowedCommandPrefixes: z.array(z.string().min(1)).optional(),
    autoDetectedCommands: z.array(z.string().min(1)).optional(),
  }).partial().optional(),
  logs: z.object({
    retentionDays: z.number().int().nonnegative().optional(),
    maxDiskMb: z.number().positive().optional(),
    storageMode: z.enum(['raw-local', 'redacted-local']).optional(),
  }).partial().optional(),
}).strict();

const profiles: ExecutionProfile[] = ['safe', 'standard', 'unrestricted'];
const DEFAULT_LOCAL_URL = 'http://localhost:8080/v1';
const DEFAULT_LOCAL_MODEL = 'local-model';
const DEFAULT_OPENROUTER_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-4o-mini';
const providerModes: ProviderMode[] = ['local', 'gateway-token', 'gateway-byok', 'openrouter-direct'];

function parseConfig(value: unknown, source: string): TokenOptimizerConfig {
  const parsed = configSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid ${source} configuration: ${parsed.error.message}`);
  return parsed.data as TokenOptimizerConfig;
}

export function loadConfigFile(filePath: string): TokenOptimizerConfig | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseConfig(value, filePath);
}

export function loadUserConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): TokenOptimizerConfig | undefined {
  const home = env.TOKEN_OPTIMIZER_CONFIG_HOME || path.join(os.homedir(), '.config', 'token-optimizer');
  return loadConfigFile(path.join(home.replace(/^~(?=$|\/)/, os.homedir()), 'config.json'));
}

export function loadProjectConfig(workspacePath: string): TokenOptimizerConfig | undefined {
  return loadConfigFile(path.join(workspacePath, '.token-optimizer.json'));
}

function narrowerProfile(ceiling: ExecutionProfile, requested: ExecutionProfile): ExecutionProfile {
  return profiles[Math.min(profiles.indexOf(ceiling), profiles.indexOf(requested))];
}

function resolveProviderConfig(input: ConfigLayers, warnings: string[]): EffectiveConfig['provider'] {
  const env = input.env || process.env;
  const configuredMode = env.TOKEN_OPTIMIZER_PROVIDER_MODE || input.tool?.provider?.mode || input.project?.provider?.mode || input.user?.provider?.mode;
  let explicit: ProviderMode | undefined;
  let invalidExplicit = false;
  if (configuredMode) {
    if (providerModes.includes(configuredMode as ProviderMode)) explicit = configuredMode as ProviderMode;
    else {
      invalidExplicit = true;
      warnings.push(`invalid provider mode TOKEN_OPTIMIZER_PROVIDER_MODE="${configuredMode}"; using local provider`);
    }
  }
  const configuredUrl = input.tool?.provider?.apiUrl || input.project?.provider?.apiUrl || input.user?.provider?.apiUrl;
  const url = configuredUrl || env.LLM_GATEWAY_URL;
  const model = input.tool?.provider?.model || input.project?.provider?.model || input.user?.provider?.model;
  const byok = env.OPENROUTER_BYOK_KEY;
  const gatewayToken = env.LLM_GATEWAY_TOKEN;
  const directKey = env.OPENROUTER_API_KEY;
  let mode: ProviderMode = explicit || (invalidExplicit ? 'local' : (url && gatewayToken ? 'gateway-token' : url && byok ? 'gateway-byok' : 'local'));
  if (mode === 'openrouter-direct' && !directKey) {
    warnings.push('openrouter-direct requested without OPENROUTER_API_KEY; using local provider');
    mode = 'local';
  }
  if (mode === 'gateway-token' && (!url || !gatewayToken)) {
    warnings.push('gateway-token requested without gateway URL and token; using local provider');
    mode = 'local';
  }
  if (mode === 'gateway-byok' && (!url || !byok)) {
    warnings.push('gateway-byok requested without gateway URL and BYOK key; using local provider');
    mode = 'local';
  }
  if (mode === 'gateway-token' && !explicit) warnings.push('gateway environment variables are a legacy compatibility configuration');
  if (mode === 'gateway-byok' && !explicit) warnings.push('OPENROUTER_BYOK_KEY is a legacy gateway-byok credential');
  if (mode === 'local') return { mode, apiUrl: configuredUrl || env.LOCAL_LLM_API_URL || DEFAULT_LOCAL_URL, model: model || env.LOCAL_LLM_MODEL || DEFAULT_LOCAL_MODEL };
  if (mode === 'openrouter-direct') return { mode, apiUrl: configuredUrl || DEFAULT_OPENROUTER_URL, model: model || env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL, credentialEnv: 'OPENROUTER_API_KEY', credential: directKey };
  return { mode, apiUrl: url as string, model: model || DEFAULT_LOCAL_MODEL, credentialEnv: mode === 'gateway-token' ? 'LLM_GATEWAY_TOKEN' : 'OPENROUTER_BYOK_KEY', credential: mode === 'gateway-token' ? gatewayToken : byok, byokCredential: mode === 'gateway-token' ? byok : undefined, byokModel: env.OPENROUTER_BYOK_MODEL?.trim() || undefined };
}

function resolveAllowlist(input: ConfigLayers): string[] {
  const user = input.user?.execution?.allowedCommandPrefixes;
  const requested = input.tool?.execution?.allowedCommandPrefixes || input.project?.execution?.allowedCommandPrefixes;
  if (!requested) return user || [];
  if (!user) return requested;
  return requested.filter((prefix) => user.some((ceiling) => prefix === ceiling || prefix.startsWith(`${ceiling} `)));
}

export function resolveEffectiveConfig(input: ConfigLayers = {}): EffectiveConfig {
  const warnings: string[] = [];
  const user = input.user ? parseConfig(input.user, 'user') : loadUserConfig(input.env);
  const project = input.project ? parseConfig(input.project, 'project') : (input.workspacePath ? loadProjectConfig(input.workspacePath) : undefined);
  const tool = input.tool ? parseConfig(input.tool, 'tool') : undefined;
  const layers = { ...input, user, project, tool };
  const ceiling = user?.execution?.profile || 'safe';
  const requested = layers.tool?.execution?.profile || layers.project?.execution?.profile || ceiling;
  if (profiles.indexOf(requested) > profiles.indexOf(ceiling)) warnings.push(`project/tool execution profile cannot elevate user ceiling (${ceiling})`);
  return {
    provider: resolveProviderConfig(layers, warnings),
    execution: {
      profile: narrowerProfile(ceiling, requested),
      allowedCommandPrefixes: resolveAllowlist(layers),
      autoDetectedCommands: layers.tool?.execution?.autoDetectedCommands || layers.project?.execution?.autoDetectedCommands || [],
    },
    logs: {
      retentionDays: layers.tool?.logs?.retentionDays ?? layers.project?.logs?.retentionDays ?? layers.user?.logs?.retentionDays ?? 7,
      maxDiskMb: layers.tool?.logs?.maxDiskMb ?? layers.project?.logs?.maxDiskMb ?? layers.user?.logs?.maxDiskMb ?? 500,
      storageMode: layers.tool?.logs?.storageMode ?? layers.project?.logs?.storageMode ?? layers.user?.logs?.storageMode ?? 'raw-local',
    },
    warnings,
  };
}

export { configSchema };
