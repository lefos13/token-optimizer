import fs from 'node:fs/promises';
import path from 'node:path';
import type { ExecutionProfile } from './types';

export type PolicyReasonCode =
  | 'ALLOWLIST_MATCH' | 'AUTO_DETECTED' | 'STANDARD_PROFILE' | 'PROFILE_UNRESTRICTED'
  | 'COMMAND_NOT_ALLOWED' | 'SENSITIVE_PATH' | 'WORKSPACE_ESCAPE'
  | 'DESTRUCTIVE_PATTERN' | 'NETWORK_EXFILTRATION' | 'NESTED_SHELL'
  | 'SHELL_METACHARACTER';

export type PolicyDecision =
  | { allowed: true; profile: ExecutionProfile; reasonCode: PolicyReasonCode }
  | { allowed: false; profile: ExecutionProfile; reasonCode: PolicyReasonCode; message: string };

export interface PolicyInput {
  command: string;
  workspacePath: string;
  profile: ExecutionProfile;
  allowedCommandPrefixes?: string[];
  autoDetectedCommands?: string[];
  /** Overridable for tests only; production callers rely on the process.platform default. */
  platform?: NodeJS.Platform;
}

const sensitivePathPattern = /(^|[\s"'])~\/(?:\.ssh|\.aws|\.config|\.gnupg)|(^|[\s"'])\/(?:etc|proc|sys|dev|root)(?:\/|\s|$)/i;
/* Secret-bearing files are matched by basename, so ordinary source and test
   paths that merely mention "credential" or "secret" stay usable while real
   secret stores (.env, keys, credential files) remain unreadable. Committed
   templates such as .env.example are not secrets. */
const secretFilePattern = /^(?:\.env(?:\.(?!(?:example|sample|template|dist|defaults)$)[^\\/]+)?|id_(?:rsa|dsa|ecdsa|ed25519)|[^\\/]+\.(?:pem|key|p12|pfx|jks|keystore)|credentials(?:\.json)?|secrets?\.(?:json|ya?ml|env)|\.npmrc|\.netrc|\.pgpass|\.git-credentials)$/i;
const environmentDumpPattern = /^(?:env|printenv|set)(?:\s|$)|\b(?:env|printenv)\s+.*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i;
const networkPattern = /\b(?:curl|wget|nc|netcat|socat|scp|ssh|ftp|telnet)\b/i;
const destructivePattern = /(?:\b(?:mkfs|fdisk|shutdown|reboot)\b|\bgit\s+(?:reset\s+--hard|clean\s+-fd)|\bdd\s+if=)/i;
const nestedShellPattern = /(?:^|[;&|]\s*|\b(?:xargs|find)\b\s+)(?:env\s+)?(?:sh|bash|zsh|fish|cmd|powershell)(?:\.exe)?\s+(?:-c|\/c|--command)\b|\beval\s+/i;

function tokens(command: string): string[] {
  return command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((token) => token.replace(/^['"]|['"]$/g, '')) || [];
}

function redirectionTargets(command: string): string[] {
  const targets: string[] = [];
  /* Match both spaced and compact operators (for example `cmd>/tmp/out` and
     `2>/tmp/out`) while ignoring descriptor duplication such as `2>&1`. */
  const patterns = [
    /(?:^|\s|[^\s])(?:\d*)>{1,2}\s*(?:"([^"]+)"|'([^']+)'|(\S+))/g,
    /(?:^|\s|[^\s])(?:\d*)<(?!!<)\s*(?:"([^"]+)"|'([^']+)'|(\S+))/g,
  ];
  for (const pattern of patterns) for (const match of command.matchAll(pattern)) {
    const target = match[1] || match[2] || match[3];
    if (target && !target.startsWith('&') && !target.startsWith('<')) targets.push(target);
  }
  return targets;
}

function hasDestructiveRm(command: string): boolean {
  const args = tokens(command);
  if (args[0] !== 'rm') return false;
  const flags = args.slice(1).filter((arg) => arg.startsWith('-') && !arg.startsWith('--'));
  return flags.some((flag) => flag.includes('r')) && flags.some((flag) => flag.includes('f'));
}

function referencesSecretFile(command: string): boolean {
  return tokens(command).some((token) => {
    const value = token.includes('=') ? token.slice(token.indexOf('=') + 1) : token;
    const basename = value.split(/[\\/]/).pop() || '';
    return secretFilePattern.test(basename);
  });
}

/* Single-quoted text is literal in POSIX shells, so `grep 'end$'` is not an
   expansion. cmd.exe has no single-quote grouping, so nothing is stripped there. */
function withoutLiteralSegments(command: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? command : command.replace(/'[^']*'/g, "''");
}

function matchesPrefix(command: string, prefixes: string[] = []): boolean {
  const normalized = command.trim();
  return prefixes.some((prefix) => {
    const candidate = prefix.trim();
    return candidate.length > 0 && (normalized === candidate || normalized.startsWith(`${candidate} `));
  });
}

type ArgsRule = (rest: string[]) => boolean;

const anyArgs: ArgsRule = () => true;
const firstArgIn = (...names: string[]): ArgsRule => (rest) => names.includes(rest[0]);
const withoutFlags = (rule: ArgsRule, ...flags: string[]): ArgsRule => (rest) =>
  rule(rest) && !rest.some((arg) => flags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)));
const requiresFlag = (...flags: string[]): ArgsRule => (rest) => rest.some((arg) => flags.includes(arg));

/*
 * Standard is the installer default: common validation runners and read-only
 * inspection run without per-project allowlist entries. Rules recognize the
 * tool plus a validating subcommand; flags that write files in place (--fix,
 * --write), run arbitrary helpers, or redirect output stay excluded. The
 * deny-first checks (paths, secrets, network, chaining) always run before this.
 */
const VALIDATION_TOOLS: Record<string, ArgsRule> = {
  tsc: anyArgs, 'vue-tsc': anyArgs,
  vitest: anyArgs, jest: anyArgs, mocha: anyArgs,
  playwright: firstArgIn('test'),
  eslint: withoutFlags(anyArgs, '--fix', '--fix-dry-run', '--output-file', '-o'),
  stylelint: withoutFlags(anyArgs, '--fix', '--output-file', '-o'),
  prettier: withoutFlags(requiresFlag('--check', '-c', '--list-different', '-l'), '--write', '-w'),
  biome: withoutFlags(firstArgIn('check', 'lint', 'ci'), '--write', '--apply', '--apply-unsafe', '--fix'),
  pytest: anyArgs, mypy: anyArgs, pyright: anyArgs, flake8: anyArgs,
  ruff: (rest) => (rest[0] === 'check' && !rest.includes('--fix')) || (rest[0] === 'format' && rest.includes('--check')),
  black: requiresFlag('--check'),
  cargo: (rest) => ['test', 'check', 'clippy', 'build', 'nextest'].includes(rest[0]) || (rest[0] === 'fmt' && rest.includes('--check')),
  go: firstArgIn('test', 'vet', 'build'),
  dotnet: firstArgIn('test', 'build'),
  mvn: firstArgIn('test', 'verify', 'compile'), './mvnw': firstArgIn('test', 'verify', 'compile'),
  gradle: firstArgIn('test', 'build', 'check'), './gradlew': firstArgIn('test', 'build', 'check'),
};

const GIT_FORBIDDEN_OPTIONS = ['--output', '--ext-diff', '--textconv', '-O', '--open-files-in-pager', '--exec', '--upload-pack'];
const GIT_BRANCH_MUTATIONS = ['-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy', '-f', '--force', '-u', '--set-upstream-to', '--unset-upstream', '--edit-description'];

const INSPECTION_TOOLS: Record<string, ArgsRule> = {
  git: (rest) => {
    const options = rest.slice(1);
    if (options.some((arg) => GIT_FORBIDDEN_OPTIONS.some((option) => arg === option || arg.startsWith(`${option}=`)))) return false;
    if (['status', 'log', 'show', 'diff', 'blame', 'ls-files', 'rev-parse', 'grep', 'shortlog'].includes(rest[0])) return true;
    /* Listing branches is read-only; any positional name or mutation flag creates, renames, or deletes one. */
    return rest[0] === 'branch' && options.every((arg) => arg.startsWith('-') && !GIT_BRANCH_MUTATIONS.includes(arg));
  },
  ls: anyArgs, pwd: anyArgs, wc: anyArgs, cat: anyArgs, head: anyArgs, tree: anyArgs, grep: anyArgs,
  tail: withoutFlags(anyArgs, '-f', '-F', '--follow'),
  rg: withoutFlags(anyArgs, '--pre', '--pre-glob'),
  find: withoutFlags(anyArgs, '-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'),
};

/* Package-runner wrappers are accepted only when the tool is already installed
   in the workspace, so recognition can never trigger a registry download.
   Bare `yarn <name>` is excluded because yarn resolves package scripts first. */
const PACKAGE_RUNNERS: Array<{ prefix: string[] }> = [
  { prefix: ['npx', '--no-install'] }, { prefix: ['npx'] }, { prefix: ['pnpm', 'exec'] }, { prefix: ['bunx'] },
];

async function localBinExists(workspacePath: string, tool: string): Promise<boolean> {
  if (!/^[a-z0-9@][a-z0-9._/-]*$/i.test(tool)) return false;
  for (const name of [tool, `${tool}.cmd`]) {
    try { await fs.access(path.join(workspacePath, 'node_modules', '.bin', name)); return true; } catch { /* try next */ }
  }
  return false;
}

function matchesNodeTest(args: string[]): boolean {
  if ((args[0] !== 'node' && args[0] !== 'node.exe') || args[1] !== '--test') return false;
  const optionsThatLoadOrWrite = [
    '-e', '--eval', '-p', '--print', '-r', '--require', '--import',
    '--loader', '--experimental-loader', '--env-file', '--env-file-if-exists',
    '--test-reporter-destination',
  ];
  return !args.slice(2).some((arg) => optionsThatLoadOrWrite.some((option) => arg === option || arg.startsWith(`${option}=`)));
}

function matchesPythonModule(args: string[]): boolean {
  if (!/^python(?:3(?:\.\d+)?)?(?:\.exe)?$/.test(args[0] || '') || args[1] !== '-m') return false;
  const [module, ...rest] = args.slice(2);
  if (module === 'unittest') return true;
  return ['pytest', 'mypy', 'ruff', 'black', 'flake8'].includes(module) && VALIDATION_TOOLS[module](rest);
}

async function matchesStandardProfileCommand(command: string, workspacePath: string): Promise<boolean> {
  const args = tokens(command);
  if (matchesNodeTest(args) || matchesPythonModule(args)) return true;
  const runner = PACKAGE_RUNNERS.find(({ prefix }) => prefix.every((part, index) => args[index] === part));
  if (runner) {
    const [tool, ...rest] = args.slice(runner.prefix.length);
    return Boolean(tool && VALIDATION_TOOLS[tool]?.(rest) && await localBinExists(workspacePath, tool));
  }
  const [tool, ...rest] = args;
  const rule = Object.prototype.hasOwnProperty.call(VALIDATION_TOOLS, tool) ? VALIDATION_TOOLS[tool]
    : Object.prototype.hasOwnProperty.call(INSPECTION_TOOLS, tool) ? INSPECTION_TOOLS[tool] : undefined;
  return Boolean(rule && rule(rest));
}

/* A copy-pasteable allowlist prefix for a command the profile rejected: the
   executable plus its subcommand when the second token is a plain word. */
export function suggestAllowPrefix(command: string): string {
  const args = tokens(command.trim());
  const second = args[1];
  return second && /^[a-z][a-z0-9:_-]*$/i.test(second) ? `${args[0]} ${second}` : args[0] || '';
}

/* runner.ts always spawns with shell:true, which resolves to cmd.exe on win32, not a POSIX
 * shell. cmd.exe does not treat backslash as an escape character and does not treat single
 * quotes as a grouping mechanism at all -- so on POSIX this scanner correctly treats
 * `\|` as an inert escaped pipe and `'...'` as an inert literal blob, but the same input
 * reaches a real live pipe/separator once cmd.exe parses it. Disabling both POSIX-only
 * allowances on win32 makes the scanner fail closed (more restrictive) there instead of
 * being silently wrong about what the actual command-line interpreter will do. */
function scanShellSyntax(command: string, platform: NodeJS.Platform = process.platform): { composition: boolean; unmatchedQuote: boolean } {
  const posix = platform !== 'win32';
  let quote: 'single' | 'double' | undefined;
  /* On win32, a single quote never groups content (cmd.exe reality) and is scanned through as
   * an ordinary character -- but that must not also disable "unmatched quote" detection, since
   * `quote` then never gets left open regardless of how many stray single quotes appear. Track
   * parity independently so an odd count still fails closed, without granting POSIX grouping. */
  let win32SingleQuoteCount = 0;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote === 'single') {
      if (char === "'") quote = undefined;
      continue;
    }
    if (quote === 'double') {
      if (char === '"') quote = undefined;
      else if (posix && char === '\\' && /[$`"\\\n]/.test(command[index + 1] || '')) index += 1;
      else if (char === '`' || (char === '$' && command[index + 1] === '(')) return { composition: true, unmatchedQuote: false };
      continue;
    }
    if (posix && char === '\\') { index += 1; continue; }
    if (char === "'") {
      if (posix) { quote = 'single'; continue; }
      win32SingleQuoteCount += 1;
      continue;
    }
    if (char === '"') { quote = 'double'; continue; }
    if (char === '$' && command[index + 1] === '(') return { composition: true, unmatchedQuote: false };
    if (/[;|&`<>\r\n]/.test(char)) return { composition: true, unmatchedQuote: false };
  }
  return { composition: false, unmatchedQuote: quote !== undefined || (!posix && win32SingleQuoteCount % 2 === 1) };
}

async function canonicalPath(candidate: string): Promise<string> {
  let current = path.resolve(candidate);
  const suffix: string[] = [];
  while (true) {
    try {
      const resolved = await fs.realpath(current);
      return path.join(resolved, ...suffix.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(candidate);
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

function isWithin(candidate: string, workspace: string): boolean {
  const relative = path.relative(workspace, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/* This is a deny-first command policy, not an operating-system sandbox. It
   rejects dangerous syntax and paths before evaluating a profile allow rule. */
async function pathDenial(command: string, workspacePath: string, platform: NodeJS.Platform): Promise<PolicyReasonCode | undefined> {
  if (/(?:\$[A-Za-z_][A-Za-z0-9_]*|\$\{[A-Za-z_][A-Za-z0-9_]*\})/.test(withoutLiteralSegments(command, platform))) return 'SENSITIVE_PATH';
  if (/(^|[\s"'])~\/(?:\.ssh|\.aws|\.config|\.gnupg)/i.test(command)) return 'SENSITIVE_PATH';
  const workspace = await canonicalPath(workspacePath);
  const candidateTokens = tokens(command).filter((token) => token !== '>' && token !== '>>' && token !== '<').concat(redirectionTargets(command));
  for (const token of candidateTokens) {
    const looksLikePath = token.startsWith('/') || token.startsWith('./') || token.startsWith('../') || token.startsWith('~/') || token.includes('/') || token === '.' || token === '..';
    if (!looksLikePath) continue;
    const expanded = token.startsWith('~/') ? path.join(process.env.HOME || '', token.slice(2)) : path.resolve(workspacePath, token);
    const canonical = await canonicalPath(expanded);
    if (!isWithin(canonical, workspace)) return 'WORKSPACE_ESCAPE';
  }
  if (sensitivePathPattern.test(command) || environmentDumpPattern.test(command) || referencesSecretFile(command)) return 'SENSITIVE_PATH';
  return undefined;
}

function deny(profile: ExecutionProfile, reasonCode: PolicyReasonCode, message: string): PolicyDecision {
  return { allowed: false, profile, reasonCode, message };
}

export async function evaluateCommand(input: PolicyInput): Promise<PolicyDecision> {
  const command = input.command.trim();
  const platform = input.platform ?? process.platform;
  const deniedPath = await pathDenial(command, input.workspacePath, platform);
  if (deniedPath) return deny(input.profile, deniedPath, deniedPath === 'SENSITIVE_PATH' ? 'Command references a sensitive path.' : 'Command references a path outside the workspace.');
  if (nestedShellPattern.test(command)) return deny(input.profile, 'NESTED_SHELL', 'Nested shell execution is not permitted.');
  if (destructivePattern.test(command) || hasDestructiveRm(command)) return deny(input.profile, 'DESTRUCTIVE_PATTERN', 'Destructive command pattern is not permitted.');
  if (networkPattern.test(command) || /(?:^|\s)(?:>|>>).*https?:\/\//i.test(command)) return deny(input.profile, 'NETWORK_EXFILTRATION', 'Network access or exfiltration is not permitted.');
  const syntax = scanShellSyntax(command, platform);
  if (syntax.composition || syntax.unmatchedQuote) return deny(input.profile, 'SHELL_METACHARACTER', syntax.unmatchedQuote ? 'Unmatched shell quote is not permitted.' : 'Command chaining, substitution, and redirection are not permitted.');
  if (input.profile === 'unrestricted') return { allowed: true, profile: input.profile, reasonCode: 'PROFILE_UNRESTRICTED' };
  if (matchesPrefix(command, input.allowedCommandPrefixes)) return { allowed: true, profile: input.profile, reasonCode: 'ALLOWLIST_MATCH' };
  if (input.profile === 'standard' && matchesPrefix(command, input.autoDetectedCommands)) return { allowed: true, profile: input.profile, reasonCode: 'AUTO_DETECTED' };
  if (input.profile === 'standard' && await matchesStandardProfileCommand(command, input.workspacePath)) return { allowed: true, profile: input.profile, reasonCode: 'STANDARD_PROFILE' };
  return deny(input.profile, 'COMMAND_NOT_ALLOWED', 'Command is not permitted by the active profile.');
}
