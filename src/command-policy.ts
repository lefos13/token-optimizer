import fs from 'node:fs/promises';
import path from 'node:path';
import type { ExecutionProfile } from './types';

export type PolicyReasonCode =
  | 'ALLOWLIST_MATCH' | 'AUTO_DETECTED' | 'PROFILE_UNRESTRICTED'
  | 'COMMAND_NOT_ALLOWED' | 'SENSITIVE_PATH' | 'WORKSPACE_ESCAPE'
  | 'DESTRUCTIVE_PATTERN' | 'NETWORK_EXFILTRATION' | 'NESTED_SHELL';

export type PolicyDecision =
  | { allowed: true; profile: ExecutionProfile; reasonCode: PolicyReasonCode }
  | { allowed: false; profile: ExecutionProfile; reasonCode: PolicyReasonCode; message: string };

export interface PolicyInput {
  command: string;
  workspacePath: string;
  profile: ExecutionProfile;
  allowedCommandPrefixes?: string[];
  autoDetectedCommands?: string[];
}

const sensitivePathPattern = /(^|[\s"'])~\/(?:\.ssh|\.aws|\.config|\.gnupg)|(^|[\s"'])\/(?:etc|proc|sys|dev|root)(?:\/|\s|$)|(?:^|[\/_.-])(credentials?|secrets?|private[_-]?key|id_rsa)(?:[./_\s-]|$)|\.env(?:\.|$)/i;
const environmentDumpPattern = /^(?:env|printenv|set)(?:\s|$)|\b(?:env|printenv)\s+.*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i;
const networkPattern = /\b(?:curl|wget|nc|netcat|socat|scp|ssh|ftp|telnet)\b/i;
const destructivePattern = /(?:\brm\s+(?:-[^\s]*f[^\s]*\s+)?(?:-rf|-fr)|\b(?:mkfs|fdisk|shutdown|reboot)\b|\bgit\s+(?:reset\s+--hard|clean\s+-fd)|\bdd\s+if=)/i;
const nestedShellPattern = /(?:^|[;&|]\s*|\b(?:xargs|find)\b\s+)(?:env\s+)?(?:sh|bash|zsh|fish|cmd|powershell)(?:\.exe)?\s+(?:-c|\/c|--command)\b|\beval\s+/i;

function tokens(command: string): string[] {
  return command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((token) => token.replace(/^['"]|['"]$/g, '')) || [];
}

function matchesPrefix(command: string, prefixes: string[] = []): boolean {
  const normalized = command.trim();
  return prefixes.some((prefix) => {
    const candidate = prefix.trim();
    return candidate.length > 0 && (normalized === candidate || normalized.startsWith(`${candidate} `));
  });
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
async function pathDenial(command: string, workspacePath: string): Promise<PolicyReasonCode | undefined> {
  if (/(^|[\s"'])~\/(?:\.ssh|\.aws|\.config|\.gnupg)/i.test(command)) return 'SENSITIVE_PATH';
  const workspace = await canonicalPath(workspacePath);
  const candidateTokens = tokens(command).filter((token) => token !== '>' && token !== '>>' && token !== '<');
  for (const token of candidateTokens) {
    const looksLikePath = token.startsWith('/') || token.startsWith('./') || token.startsWith('../') || token.startsWith('~/') || token.includes('/') || token === '.' || token === '..';
    if (!looksLikePath) continue;
    const expanded = token.startsWith('~/') ? path.join(process.env.HOME || '', token.slice(2)) : path.resolve(workspacePath, token);
    const canonical = await canonicalPath(expanded);
    if (!isWithin(canonical, workspace)) return 'WORKSPACE_ESCAPE';
  }
  if (sensitivePathPattern.test(command) || environmentDumpPattern.test(command)) return 'SENSITIVE_PATH';
  return undefined;
}

function deny(profile: ExecutionProfile, reasonCode: PolicyReasonCode, message: string): PolicyDecision {
  return { allowed: false, profile, reasonCode, message };
}

export async function evaluateCommand(input: PolicyInput): Promise<PolicyDecision> {
  const command = input.command.trim();
  const deniedPath = await pathDenial(command, input.workspacePath);
  if (deniedPath) return deny(input.profile, deniedPath, deniedPath === 'SENSITIVE_PATH' ? 'Command references a sensitive path.' : 'Command references a path outside the workspace.');
  if (nestedShellPattern.test(command)) return deny(input.profile, 'NESTED_SHELL', 'Nested shell execution is not permitted.');
  if (destructivePattern.test(command)) return deny(input.profile, 'DESTRUCTIVE_PATTERN', 'Destructive command pattern is not permitted.');
  if (networkPattern.test(command) || /(?:^|\s)(?:>|>>).*https?:\/\//i.test(command)) return deny(input.profile, 'NETWORK_EXFILTRATION', 'Network access or exfiltration is not permitted.');
  if (input.profile === 'unrestricted') return { allowed: true, profile: input.profile, reasonCode: 'PROFILE_UNRESTRICTED' };
  if (matchesPrefix(command, input.allowedCommandPrefixes)) return { allowed: true, profile: input.profile, reasonCode: 'ALLOWLIST_MATCH' };
  if (input.profile === 'standard' && matchesPrefix(command, input.autoDetectedCommands)) return { allowed: true, profile: input.profile, reasonCode: 'AUTO_DETECTED' };
  return deny(input.profile, 'COMMAND_NOT_ALLOWED', 'Command is not permitted by the active profile.');
}
