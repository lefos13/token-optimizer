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
/* Configuration is intentionally layered and conservative: lower-trust project and
 * tool inputs may narrow behavior, but cannot widen a user-selected safety ceiling. */
const configSchema = zod_1.z.object({
    provider: zod_1.z.object({
        mode: zod_1.z.enum(['local', 'gateway-token', 'gateway-byok', 'openrouter-direct']).optional(),
        apiUrl: zod_1.z.string().min(1).optional(),
        model: zod_1.z.string().min(1).optional(),
        credentialRef: zod_1.z.string().min(1).max(256).optional(),
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
const providerModes = ['local', 'gateway-token', 'gateway-byok', 'openrouter-direct'];
function parseConfig(value, source) {
    const parsed = configSchema.safeParse(value);
    if (!parsed.success)
        throw new Error(`Invalid ${source} configuration: ${parsed.error.message}`);
    return parsed.data;
}
function loadConfigFile(filePath, rootPath = node_path_1.default.dirname(filePath)) {
    if (!node_fs_1.default.existsSync(filePath))
        return undefined;
    const root = node_fs_1.default.realpathSync(rootPath);
    const stat = node_fs_1.default.lstatSync(filePath);
    if (stat.isSymbolicLink())
        throw new Error(`Configuration file must not be a symbolic link: ${filePath}`);
    if (!stat.isFile())
        throw new Error(`Configuration path is not a regular file: ${filePath}`);
    const canonical = node_fs_1.default.realpathSync(filePath);
    if (canonical !== root && !canonical.startsWith(`${root}${node_path_1.default.sep}`))
        throw new Error(`Configuration path escapes its trusted root: ${filePath}`);
    let value;
    try {
        value = JSON.parse(node_fs_1.default.readFileSync(filePath, 'utf8'));
    }
    catch (error) {
        throw new Error(`Unable to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return parseConfig(value, filePath);
}
function loadUserConfig(env = process.env) {
    const home = env.TOKEN_OPTIMIZER_CONFIG_HOME || node_path_1.default.join(node_os_1.default.homedir(), '.config', 'token-optimizer');
    const root = node_path_1.default.resolve(home.replace(/^~(?=$|\/)/, node_os_1.default.homedir()));
    return loadConfigFile(node_path_1.default.join(root, 'config.json'), root);
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
    const explicitMode = input.tool?.provider?.mode || input.project?.provider?.mode || input.user?.provider?.mode;
    const configuredMode = explicitMode || env.TOKEN_OPTIMIZER_PROVIDER_MODE;
    let explicit;
    let invalidExplicit = false;
    if (configuredMode) {
        if (providerModes.includes(configuredMode))
            explicit = configuredMode;
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
    let mode = explicit || (invalidExplicit ? 'local' : (url && gatewayToken ? 'gateway-token' : url && byok ? 'gateway-byok' : 'local'));
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
    if (mode === 'gateway-token' && !explicit)
        warnings.push('gateway environment variables are a legacy compatibility configuration');
    if (mode === 'gateway-byok' && !explicit)
        warnings.push('OPENROUTER_BYOK_KEY is a legacy gateway-byok credential');
    const metadata = { credentialRef: input.tool?.provider?.credentialRef || input.project?.provider?.credentialRef || input.user?.provider?.credentialRef, taskRouting: input.tool?.provider?.taskRouting || input.project?.provider?.taskRouting || input.user?.provider?.taskRouting };
    if (mode === 'local')
        return { mode, apiUrl: configuredUrl || env.LOCAL_LLM_API_URL || DEFAULT_LOCAL_URL, model: model || env.LOCAL_LLM_MODEL || DEFAULT_LOCAL_MODEL, ...metadata };
    if (mode === 'openrouter-direct')
        return { mode, apiUrl: configuredUrl || DEFAULT_OPENROUTER_URL, model: model || env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL, ...metadata, credentialEnv: 'OPENROUTER_API_KEY', credential: directKey };
    return { mode, apiUrl: url, model: model || DEFAULT_LOCAL_MODEL, ...metadata, credentialEnv: mode === 'gateway-token' ? 'LLM_GATEWAY_TOKEN' : 'OPENROUTER_BYOK_KEY', credential: mode === 'gateway-token' ? gatewayToken : byok, byokCredential: mode === 'gateway-token' ? byok : undefined, byokModel: env.OPENROUTER_BYOK_MODEL?.trim() || undefined };
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
    if (profiles.indexOf(requested) > profiles.indexOf(ceiling))
        warnings.push(`project/tool execution profile cannot elevate user ceiling (${ceiling})`);
    return {
        provider: resolveProviderConfig(layers, warnings),
        execution: {
            profile: narrowerProfile(ceiling, requested),
            allowedCommandPrefixes: resolveAllowlist(layers),
            autoDetectedCommands: layers.tool?.execution?.autoDetectedCommands || layers.project?.execution?.autoDetectedCommands || [],
        },
        /* Lower-trust layers may reduce retention/quota or request redaction, but may
         * never restore raw logs or enlarge limits fixed by the user policy. */
        logs: (() => {
            const base = layers.user?.logs;
            const requested = layers.tool?.logs || layers.project?.logs;
            return {
                retentionDays: Math.min(base?.retentionDays ?? 7, requested?.retentionDays ?? Infinity),
                maxDiskMb: Math.min(base?.maxDiskMb ?? 500, requested?.maxDiskMb ?? Infinity),
                storageMode: base?.storageMode === 'redacted-local' || requested?.storageMode === 'redacted-local' ? 'redacted-local' : 'raw-local',
            };
        })(),
        redaction: { rules: layers.tool?.redaction?.rules || layers.project?.redaction?.rules || layers.user?.redaction?.rules || [] },
        warnings,
    };
}
