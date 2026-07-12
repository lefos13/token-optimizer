"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluateCommand = evaluateCommand;
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
const sensitivePathPattern = /(^|[\s"'])~\/(?:\.ssh|\.aws|\.config|\.gnupg)|(^|[\s"'])\/(?:etc|proc|sys|dev|root)(?:\/|\s|$)|(?:^|[\/_.-])(credentials?|secrets?|private[_-]?key|id_rsa)(?:[./_\s-]|$)|\.env(?:\.|$)/i;
const environmentDumpPattern = /^(?:env|printenv|set)(?:\s|$)|\b(?:env|printenv)\s+.*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i;
const networkPattern = /\b(?:curl|wget|nc|netcat|socat|scp|ssh|ftp|telnet)\b/i;
const destructivePattern = /(?:\b(?:mkfs|fdisk|shutdown|reboot)\b|\bgit\s+(?:reset\s+--hard|clean\s+-fd)|\bdd\s+if=)/i;
const nestedShellPattern = /(?:^|[;&|]\s*|\b(?:xargs|find)\b\s+)(?:env\s+)?(?:sh|bash|zsh|fish|cmd|powershell)(?:\.exe)?\s+(?:-c|\/c|--command)\b|\beval\s+/i;
function tokens(command) {
    return command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((token) => token.replace(/^['"]|['"]$/g, '')) || [];
}
function redirectionTargets(command) {
    const targets = [];
    /* Match both spaced and compact operators (for example `cmd>/tmp/out` and
       `2>/tmp/out`) while ignoring descriptor duplication such as `2>&1`. */
    const patterns = [
        /(?:^|\s|[^\s])(?:\d*)>{1,2}\s*(?:"([^"]+)"|'([^']+)'|(\S+))/g,
        /(?:^|\s|[^\s])(?:\d*)<(?!!<)\s*(?:"([^"]+)"|'([^']+)'|(\S+))/g,
    ];
    for (const pattern of patterns)
        for (const match of command.matchAll(pattern)) {
            const target = match[1] || match[2] || match[3];
            if (target && !target.startsWith('&') && !target.startsWith('<'))
                targets.push(target);
        }
    return targets;
}
function hasDestructiveRm(command) {
    const args = tokens(command);
    if (args[0] !== 'rm')
        return false;
    const flags = args.slice(1).filter((arg) => arg.startsWith('-') && !arg.startsWith('--'));
    return flags.some((flag) => flag.includes('r')) && flags.some((flag) => flag.includes('f'));
}
function matchesPrefix(command, prefixes = []) {
    const normalized = command.trim();
    return prefixes.some((prefix) => {
        const candidate = prefix.trim();
        return candidate.length > 0 && (normalized === candidate || normalized.startsWith(`${candidate} `));
    });
}
function scanShellSyntax(command) {
    let quote;
    for (let index = 0; index < command.length; index += 1) {
        const char = command[index];
        if (quote === 'single') {
            if (char === "'")
                quote = undefined;
            continue;
        }
        if (quote === 'double') {
            if (char === '"')
                quote = undefined;
            else if (char === '\\' && /[$`"\\\n]/.test(command[index + 1] || ''))
                index += 1;
            else if (char === '`' || (char === '$' && command[index + 1] === '('))
                return { composition: true, unmatchedQuote: false };
            continue;
        }
        if (char === '\\') {
            index += 1;
            continue;
        }
        if (char === "'") {
            quote = 'single';
            continue;
        }
        if (char === '"') {
            quote = 'double';
            continue;
        }
        if (char === '$' && command[index + 1] === '(')
            return { composition: true, unmatchedQuote: false };
        if (/[;|&`<>\r\n]/.test(char))
            return { composition: true, unmatchedQuote: false };
    }
    return { composition: false, unmatchedQuote: quote !== undefined };
}
async function canonicalPath(candidate) {
    let current = node_path_1.default.resolve(candidate);
    const suffix = [];
    while (true) {
        try {
            const resolved = await promises_1.default.realpath(current);
            return node_path_1.default.join(resolved, ...suffix.reverse());
        }
        catch {
            const parent = node_path_1.default.dirname(current);
            if (parent === current)
                return node_path_1.default.resolve(candidate);
            suffix.push(node_path_1.default.basename(current));
            current = parent;
        }
    }
}
function isWithin(candidate, workspace) {
    const relative = node_path_1.default.relative(workspace, candidate);
    return relative === '' || (!relative.startsWith(`..${node_path_1.default.sep}`) && relative !== '..' && !node_path_1.default.isAbsolute(relative));
}
/* This is a deny-first command policy, not an operating-system sandbox. It
   rejects dangerous syntax and paths before evaluating a profile allow rule. */
async function pathDenial(command, workspacePath) {
    if (/(?:\$HOME|\$\{HOME\}|\$[A-Za-z_][A-Za-z0-9_]*|\$\{[A-Za-z_][A-Za-z0-9_]*\})/.test(command))
        return 'SENSITIVE_PATH';
    if (/(^|[\s"'])~\/(?:\.ssh|\.aws|\.config|\.gnupg)/i.test(command))
        return 'SENSITIVE_PATH';
    const workspace = await canonicalPath(workspacePath);
    const candidateTokens = tokens(command).filter((token) => token !== '>' && token !== '>>' && token !== '<').concat(redirectionTargets(command));
    for (const token of candidateTokens) {
        const looksLikePath = token.startsWith('/') || token.startsWith('./') || token.startsWith('../') || token.startsWith('~/') || token.includes('/') || token === '.' || token === '..';
        if (!looksLikePath)
            continue;
        const expanded = token.startsWith('~/') ? node_path_1.default.join(process.env.HOME || '', token.slice(2)) : node_path_1.default.resolve(workspacePath, token);
        const canonical = await canonicalPath(expanded);
        if (!isWithin(canonical, workspace))
            return 'WORKSPACE_ESCAPE';
    }
    if (sensitivePathPattern.test(command) || environmentDumpPattern.test(command))
        return 'SENSITIVE_PATH';
    return undefined;
}
function deny(profile, reasonCode, message) {
    return { allowed: false, profile, reasonCode, message };
}
async function evaluateCommand(input) {
    const command = input.command.trim();
    const deniedPath = await pathDenial(command, input.workspacePath);
    if (deniedPath)
        return deny(input.profile, deniedPath, deniedPath === 'SENSITIVE_PATH' ? 'Command references a sensitive path.' : 'Command references a path outside the workspace.');
    if (nestedShellPattern.test(command))
        return deny(input.profile, 'NESTED_SHELL', 'Nested shell execution is not permitted.');
    if (destructivePattern.test(command) || hasDestructiveRm(command))
        return deny(input.profile, 'DESTRUCTIVE_PATTERN', 'Destructive command pattern is not permitted.');
    if (networkPattern.test(command) || /(?:^|\s)(?:>|>>).*https?:\/\//i.test(command))
        return deny(input.profile, 'NETWORK_EXFILTRATION', 'Network access or exfiltration is not permitted.');
    const syntax = scanShellSyntax(command);
    if (syntax.composition || syntax.unmatchedQuote)
        return deny(input.profile, 'SHELL_METACHARACTER', syntax.unmatchedQuote ? 'Unmatched shell quote is not permitted.' : 'Command chaining, substitution, and redirection are not permitted.');
    if (input.profile === 'unrestricted')
        return { allowed: true, profile: input.profile, reasonCode: 'PROFILE_UNRESTRICTED' };
    if (matchesPrefix(command, input.allowedCommandPrefixes))
        return { allowed: true, profile: input.profile, reasonCode: 'ALLOWLIST_MATCH' };
    if (input.profile === 'standard' && matchesPrefix(command, input.autoDetectedCommands))
        return { allowed: true, profile: input.profile, reasonCode: 'AUTO_DETECTED' };
    return deny(input.profile, 'COMMAND_NOT_ALLOWED', 'Command is not permitted by the active profile.');
}
