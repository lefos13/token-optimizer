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
const providerModes: ProviderMode[] = ['local', 'gateway-token', 'gateway-byok', 'openrouter-direct'];

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
  let explicit: ProviderMode | undefined;
  let invalidExplicit = false;
  if (configuredMode) {
    if (providerModes.includes(configuredMode as ProviderMode)) explicit = configuredMode as ProviderMode;
    else {
      invalidExplicit = true;
      warnings.push(`invalid provider mode TOKEN_OPTIMIZER_PROVIDER_MODE="${configuredMode}"; using local provider`);
    }
  }
  const configuredUrl = userProvider?.apiUrl;
  const url = configuredUrl || env.LLM_GATEWAY_URL;
  const model = userProvider?.model;
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
  const metadata = { taskRouting: userProvider?.taskRouting };
  if (mode === 'local') return { mode, apiUrl: configuredUrl || env.LOCAL_LLM_API_URL || DEFAULT_LOCAL_URL, model: model || env.LOCAL_LLM_MODEL || DEFAULT_LOCAL_MODEL, ...metadata };
  if (mode === 'openrouter-direct') return { mode, apiUrl: configuredUrl || DEFAULT_OPENROUTER_URL, model: model || env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL, ...metadata, credentialEnv: 'OPENROUTER_API_KEY', credential: directKey };
  return { mode, apiUrl: url as string, model: model || DEFAULT_LOCAL_MODEL, ...metadata, credentialEnv: mode === 'gateway-token' ? 'LLM_GATEWAY_TOKEN' : 'OPENROUTER_BYOK_KEY', credential: mode === 'gateway-token' ? gatewayToken : byok, byokCredential: mode === 'gateway-token' ? byok : undefined, byokModel: env.OPENROUTER_BYOK_MODEL?.trim() || undefined };
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
