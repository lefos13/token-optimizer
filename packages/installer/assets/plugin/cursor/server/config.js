"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.configSchema = void 0;
exports.loadConfigFile = loadConfigFile;
exports.loadUserConfig = loadUserConfig;
exports.loadProjectConfig = loadProjectConfig;
exports.resolveEffectiveConfig = resolveEffectiveConfig;
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const zod_1 = require("zod");
const redaction_1 = require("./redaction");
/* Configuration is intentionally layered and conservative: lower-trust project and
 * tool inputs may narrow behavior, but cannot widen a user-selected safety ceiling. */
const configSchema = zod_1.z.object({
    provider: zod_1.z.object({
        mode: zod_1.z.enum(['local', 'gateway-token', 'gateway-byok', 'openrouter-direct']).optional(),
        apiUrl: zod_1.z.string().min(1).optional(),
        model: zod_1.z.string().min(1).optional(),
        taskRouting: zod_1.z.partialRecord(zod_1.z.enum(['verdict', 'triage', 'review', 'digest', 'scout', 'query']), zod_1.z.string().min(1).max(256)).optional(),
    }).partial().optional(),
    execution: zod_1.z.object({
        profile: zod_1.z.enum(['safe', 'standard', 'unrestricted']).optional(),
        allowedCommandPrefixes: zod_1.z.array(zod_1.z.string().min(1)).optional(),
        autoDetectedCommands: zod_1.z.array(zod_1.z.string().min(1)).optional(),
    }).partial().optional(),
    logs: zod_1.z.object({
        retentionDays: zod_1.z.number().int().nonnegative().optional(),
        maxDiskMb: zod_1.z.number().positive().optional(),
        storageMode: zod_1.z.enum(['raw-local', 'redacted-local']).optional(),
    }).partial().optional(),
    redaction: zod_1.z.object({ rules: zod_1.z.array(zod_1.z.object({ pattern: zod_1.z.string().min(1).max(500), flags: zod_1.z.string().max(10).optional(), category: zod_1.z.string().min(1).max(64), replacement: zod_1.z.string().max(256).optional() }).strict()).max(20) }).strict().optional(),
}).strict();
exports.configSchema = configSchema;
const profiles = ['safe', 'standard', 'unrestricted'];
const DEFAULT_LOCAL_URL = 'http://localhost:8080/v1';
const DEFAULT_LOCAL_MODEL = 'local-model';
const DEFAULT_OPENROUTER_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-4o-mini';
const providerModes = ['local', 'openrouter-direct'];
function parseConfig(value, source) {
    const parsed = configSchema.safeParse(value);
    if (!parsed.success)
        throw new Error(`Invalid ${source} configuration: ${parsed.error.message}`);
    if (parsed.data.redaction?.rules) {
        try {
            (0, redaction_1.redactText)('', { customRules: parsed.data.redaction.rules });
        }
        catch (error) {
            throw new Error(`Invalid ${source} redaction configuration: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return parsed.data;
}
const MAX_CONFIG_BYTES = 64 * 1024;
/* Config bytes are read from the same descriptor that is validated. This
 * prevents a path swap between validation and read and rejects symlinks at open. */
function loadConfigFile(filePath, rootPath = node_path_1.default.dirname(filePath), authoritativeUser = false) {
    if (!node_fs_1.default.existsSync(filePath))
        return undefined;
    const requestedRoot = node_path_1.default.resolve(rootPath);
    const requestedFile = node_path_1.default.resolve(filePath);
    const relative = node_path_1.default.relative(requestedRoot, requestedFile);
    if (relative.startsWith('..') || node_path_1.default.isAbsolute(relative))
        throw new Error(`Configuration path escapes its trusted root: ${filePath}`);
    const root = node_fs_1.default.realpathSync(rootPath);
    const resolved = node_path_1.default.join(root, relative);
    let descriptor;
    let value;
    try {
        const noFollow = node_fs_1.default.constants.O_NOFOLLOW || 0;
        descriptor = node_fs_1.default.openSync(resolved, node_fs_1.default.constants.O_RDONLY | noFollow);
        const stat = node_fs_1.default.fstatSync(descriptor);
        if (!stat.isFile())
            throw new Error(`Configuration path is not a regular file: ${filePath}`);
        if (stat.size > MAX_CONFIG_BYTES)
            throw new Error(`Configuration file is too large: ${filePath}`);
        if (authoritativeUser && process.platform !== 'win32') {
            if ((stat.mode & 0o077) !== 0)
                throw new Error(`Authoritative user configuration has unsafe permissions: ${filePath}`);
            if (typeof process.getuid === 'function' && stat.uid !== process.getuid())
                throw new Error(`Authoritative user configuration has unexpected ownership: ${filePath}`);
        }
        const bytes = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < bytes.length) {
            const count = node_fs_1.default.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
            if (count === 0)
                break;
            offset += count;
        }
        value = JSON.parse(bytes.subarray(0, offset).toString('utf8'));
    }
    catch (error) {
        throw new Error(`Unable to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    finally {
        if (descriptor !== undefined)
            node_fs_1.default.closeSync(descriptor);
    }
    return parseConfig(value, filePath);
}
function loadUserConfig(env = process.env) {
    const home = env.TOKEN_OPTIMIZER_CONFIG_HOME || node_path_1.default.join(node_os_1.default.homedir(), '.config', 'token-optimizer');
    const root = node_path_1.default.resolve(home.replace(/^~(?=$|\/)/, node_os_1.default.homedir()));
    return loadConfigFile(node_path_1.default.join(root, 'config.json'), root, true);
}
function loadProjectConfig(workspacePath) {
    const root = node_fs_1.default.realpathSync(workspacePath);
    return loadConfigFile(node_path_1.default.join(root, '.token-optimizer.json'), root);
}
function narrowerProfile(ceiling, requested) {
    return profiles[Math.min(profiles.indexOf(ceiling), profiles.indexOf(requested))];
}
function resolveProviderConfig(input, warnings) {
    const env = input.env || process.env;
    const userProvider = input.user?.provider;
    if (input.project?.provider || input.tool?.provider)
        warnings.push('lower-trust provider configuration ignored; provider destination and routing require user approval');
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
        }
        else {
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
    let mode = configuredMode || (env.OPENROUTER_API_KEY ? 'openrouter-direct' : 'local');
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
function resolveAllowlist(input) {
    const user = input.user?.execution?.allowedCommandPrefixes;
    const requested = input.tool?.execution?.allowedCommandPrefixes || input.project?.execution?.allowedCommandPrefixes;
    if (!requested)
        return user || [];
    if (!user)
        return requested;
    return requested.filter((prefix) => user.some((ceiling) => prefix === ceiling || prefix.startsWith(`${ceiling} `)));
}
function resolveEffectiveConfig(input = {}) {
    const warnings = [];
    const user = input.user ? parseConfig(input.user, 'user') : loadUserConfig(input.env);
    const project = input.project ? parseConfig(input.project, 'project') : (input.workspacePath ? loadProjectConfig(input.workspacePath) : undefined);
    const tool = input.tool ? parseConfig(input.tool, 'tool') : undefined;
    const layers = { ...input, user, project, tool };
    const ceiling = user?.execution?.profile || 'safe';
    const requested = layers.tool?.execution?.profile || layers.project?.execution?.profile || ceiling;
    const profileSource = layers.tool?.execution?.profile ? 'tool' : layers.project?.execution?.profile ? 'project' : user?.execution?.profile ? 'user' : 'implicit-default';
    if (profiles.indexOf(requested) > profiles.indexOf(ceiling))
        warnings.push(`project/tool execution profile cannot elevate user ceiling (${ceiling})`);
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
        logs: (() => {
            const candidates = [layers.user?.logs, layers.project?.logs, layers.tool?.logs];
            return {
                retentionDays: Math.min(7, ...candidates.map((value) => value?.retentionDays ?? Infinity)),
                maxDiskMb: Math.min(500, ...candidates.map((value) => value?.maxDiskMb ?? Infinity)),
                storageMode: candidates.some((value) => value?.storageMode === 'redacted-local') ? 'redacted-local' : 'raw-local',
            };
        })(),
        redaction: (() => { const rules = [...(layers.user?.redaction?.rules || []), ...(layers.project?.redaction?.rules || []), ...(layers.tool?.redaction?.rules || [])]; if (rules.length > 20)
            throw new Error('Effective redaction configuration has too many rules (maximum 20)'); (0, redaction_1.redactText)('', { customRules: rules }); return { rules }; })(),
        warnings,
    };
}
