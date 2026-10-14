import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { redactText } from './redaction';
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
    taskRouting: z.partialRecord(z.enum(['verdict', 'triage', 'review', 'digest', 'scout', 'query']), z.string().min(1).max(256)).optional(),
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
  redaction: z.object({ rules: z.array(z.object({ pattern: z.string().min(1).max(500), flags: z.string().max(10).optional(), category: z.string().min(1).max(64), replacement: z.string().max(256).optional() }).strict()).max(20) }).strict().optional(),
}).strict();

const profiles: ExecutionProfile[] = ['safe', 'standard', 'unrestricted'];
const DEFAULT_LOCAL_URL = 'http://localhost:8080/v1';
const DEFAULT_LOCAL_MODEL = 'local-model';
const DEFAULT_OPENROUTER_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-4o-mini';
const providerModes: ProviderMode[] = ['local', 'openrouter-direct'];

function parseConfig(value: unknown, source: string): TokenOptimizerConfig {
  const parsed = configSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid ${source} configuration: ${parsed.error.message}`);
  if (parsed.data.redaction?.rules) {
    try { redactText('', { customRules: parsed.data.redaction.rules }); }
    catch (error) { throw new Error(`Invalid ${source} redaction configuration: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return parsed.data as TokenOptimizerConfig;
}

const MAX_CONFIG_BYTES = 64 * 1024;

/* Config bytes are read from the same descriptor that is validated. This
 * prevents a path swap between validation and read and rejects symlinks at open. */
export function loadConfigFile(filePath: string, rootPath: string = path.dirname(filePath), authoritativeUser = false): TokenOptimizerConfig | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  const requestedRoot = path.resolve(rootPath);
  const requestedFile = path.resolve(filePath);
  const relative = path.relative(requestedRoot, requestedFile);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Configuration path escapes its trusted root: ${filePath}`);
  const root = fs.realpathSync(rootPath);
  const resolved = path.join(root, relative);
  let descriptor: number | undefined;
  let value: unknown;
  try {
    const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW || 0;
    descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error(`Configuration path is not a regular file: ${filePath}`);
    if (stat.size > MAX_CONFIG_BYTES) throw new Error(`Configuration file is too large: ${filePath}`);
    if (authoritativeUser && process.platform !== 'win32') {
      if ((stat.mode & 0o077) !== 0) throw new Error(`Authoritative user configuration has unsafe permissions: ${filePath}`);
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error(`Authoritative user configuration has unexpected ownership: ${filePath}`);
    }
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) { const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset); if (count === 0) break; offset += count; }
    value = JSON.parse(bytes.subarray(0, offset).toString('utf8'));
  } catch (error) {
    throw new Error(`Unable to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  return parseConfig(value, filePath);
}

export function loadUserConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): TokenOptimizerConfig | undefined {
  const home = env.TOKEN_OPTIMIZER_CONFIG_HOME || path.join(os.homedir(), '.config', 'token-optimizer');
  const root = path.resolve(home.replace(/^~(?=$|\/)/, os.homedir()));
  return loadConfigFile(path.join(root, 'config.json'), root, true);
}

export function loadProjectConfig(workspacePath: string): TokenOptimizerConfig | undefined {
  const root = fs.realpathSync(workspacePath);
  return loadConfigFile(path.join(root, '.token-optimizer.json'), root);
}

function narrowerProfile(ceiling: ExecutionProfile, requested: ExecutionProfile): ExecutionProfile {
  return profiles[Math.min(profiles.indexOf(ceiling), profiles.indexOf(requested))];
}

function resolveProviderConfig(input: ConfigLayers, warnings: string[]): EffectiveConfig['provider'] {
  const env = input.env || process.env;
  const userProvider = input.user?.provider;
  if (input.project?.provider || input.tool?.provider) warnings.push('lower-trust provider configuration ignored; provider destination and routing require user approval');
  const explicitMode = userProvider?.mode;
  const configuredMode = explicitMode || env.TOKEN_OPTIMIZER_PROVIDER_MODE;
  const configuredUrl = userProvider?.apiUrl;
  const model = userProvider?.model;
  const metadata = { taskRouting: userProvider?.taskRouting };

  const ALL_KNOWN_MODES = ['local', 'openrouter-direct', 'gateway-token', 'gateway-byok'];
  let invalidExplicit = false;
  if (configuredMode) {
    if (!ALL_KNOWN_MODES.includes(configuredMode)) {
      invalidExplicit = true;
      warnings.push(`invalid provider mode TOKEN_OPTIMIZER_PROVIDER_MODE="${configuredMode}"; using local provider`);
    }
  }

  if (invalidExplicit) {
    return {
      mode: 'local',
      apiUrl: configuredUrl || env.LOCAL_LLM_API_URL || DEFAULT_LOCAL_URL,
      model: model || env.LOCAL_LLM_MODEL || DEFAULT_LOCAL_MODEL,
      ...metadata
    };
  }

  const isLegacyMode = configuredMode === 'gateway-token' || configuredMode === 'gateway-byok';
  const hasLegacyEnv = Boolean(env.LLM_GATEWAY_URL || env.LLM_GATEWAY_TOKEN || env.OPENROUTER_BYOK_KEY);
  const shouldMigrate = isLegacyMode || (!configuredMode && hasLegacyEnv);

  if (shouldMigrate) {
    /* A legacy user config carries the gateway URL and a gateway-managed model
       name; neither is valid for OpenRouter or a local endpoint, so drop them. */
    const legacyUrl = isLegacyMode ? undefined : configuredUrl;
    const legacyModel = isLegacyMode ? undefined : model;
    const openrouterKey = env.OPENROUTER_API_KEY || env.OPENROUTER_BYOK_KEY;
    if (openrouterKey) {
      warnings.push('Gateway support was removed; your key is now used directly with OpenRouter.');
      const resolvedModel = legacyModel || env.OPENROUTER_MODEL || env.OPENROUTER_BYOK_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL;
      return {
        mode: 'openrouter-direct',
        apiUrl: legacyUrl || env.OPENROUTER_API_URL || DEFAULT_OPENROUTER_URL,
        model: resolvedModel,
        credentialEnv: env.OPENROUTER_API_KEY ? 'OPENROUTER_API_KEY' : 'OPENROUTER_BYOK_KEY',
        credential: openrouterKey,
        ...metadata
      };
    } else {
      warnings.push('Gateway support was removed; run `token-optimizer config` to choose openrouter or local.');
      return {
        mode: 'local',
        apiUrl: legacyUrl || env.LOCAL_LLM_API_URL || DEFAULT_LOCAL_URL,
        model: legacyModel || env.LOCAL_LLM_MODEL || DEFAULT_LOCAL_MODEL,
        ...metadata
      };
    }
  }

  /* With no explicit mode, an OpenRouter key in the environment is enough to
     select openrouter-direct; otherwise inference stays on the local endpoint. */
  let mode: ProviderMode = (configuredMode as ProviderMode) || (env.OPENROUTER_API_KEY ? 'openrouter-direct' : 'local');
  if (mode === 'openrouter-direct') {
    const key = env.OPENROUTER_API_KEY || env.OPENROUTER_BYOK_KEY;
    if (!key) {
      warnings.push('openrouter-direct requested without OPENROUTER_API_KEY; using local provider');
      return {
        mode: 'local',
        apiUrl: configuredUrl || env.LOCAL_LLM_API_URL || DEFAULT_LOCAL_URL,
        model: model || env.LOCAL_LLM_MODEL || DEFAULT_LOCAL_MODEL,
        ...metadata
      };
    }
    const resolvedModel = model || env.OPENROUTER_MODEL || env.OPENROUTER_BYOK_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL;
    return {
      mode: 'openrouter-direct',
      apiUrl: configuredUrl || env.OPENROUTER_API_URL || DEFAULT_OPENROUTER_URL,
      model: resolvedModel,
      credentialEnv: env.OPENROUTER_API_KEY ? 'OPENROUTER_API_KEY' : 'OPENROUTER_BYOK_KEY',
      credential: key,
      ...metadata
    };
  }

  return {
    mode: 'local',
    apiUrl: configuredUrl || env.LOCAL_LLM_API_URL || DEFAULT_LOCAL_URL,
    model: model || env.LOCAL_LLM_MODEL || DEFAULT_LOCAL_MODEL,
    ...metadata
  };
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
  const profileSource = layers.tool?.execution?.profile ? 'tool' : layers.project?.execution?.profile ? 'project' : user?.execution?.profile ? 'user' : 'implicit-default';
  if (profiles.indexOf(requested) > profiles.indexOf(ceiling)) warnings.push(`project/tool execution profile cannot elevate user ceiling (${ceiling})`);
  return {
    provider: resolveProviderConfig(layers, warnings),
    execution: {
      profile: narrowerProfile(ceiling, requested),
      profileSource,
      allowedCommandPrefixes: resolveAllowlist(layers),
      autoDetectedCommands: layers.tool?.execution?.autoDetectedCommands || layers.project?.execution?.autoDetectedCommands || [],
    },
    /* Lower-trust layers may reduce retention/quota or request redaction, but may
     * never restore raw logs or enlarge limits fixed by the user policy. */
    logs: (() => { const candidates = [layers.user?.logs, layers.project?.logs, layers.tool?.logs]; return {
      retentionDays: Math.min(7, ...candidates.map((value) => value?.retentionDays ?? Infinity)),
      maxDiskMb: Math.min(500, ...candidates.map((value) => value?.maxDiskMb ?? Infinity)),
      storageMode: candidates.some((value) => value?.storageMode === 'redacted-local') ? 'redacted-local' as const : 'raw-local' as const,
    }; })(),
    redaction: (() => { const rules = [...(layers.user?.redaction?.rules || []), ...(layers.project?.redaction?.rules || []), ...(layers.tool?.redaction?.rules || [])]; if (rules.length > 20) throw new Error('Effective redaction configuration has too many rules (maximum 20)'); redactText('', { customRules: rules }); return { rules }; })(),
    warnings,
  };
}

export { configSchema };
