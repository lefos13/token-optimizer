#!/usr/bin/env node

const readline = require("readline");
const {
  DEFAULT_GATEWAY_URL,
  DEFAULT_LOCAL_LLM_URL,
  DEFAULT_LOCAL_LLM_MODEL,
  normalizeProviderChoice,
  installSelectedClients,
  applyGatewayConfig,
  applyDefaultDirectives,
} = require("../lib/install-core");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || "install";

  if (args.help || command === "help") {
    printHelp();
    return;
  }

  if (!["install", "config", "defaults"].includes(command)) {
    throw new Error(`Unsupported command: ${command}`);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const clients = parseList(args.clients || args.client || "detected");
    const providerOptions = await resolveProviderOptions(args, rl);
    const defaults = args.defaults !== "false" && args["no-defaults"] !== true;
    const options = {
      clients,
      ...providerOptions,
      defaults,
      cursorProjects: parseList(args["cursor-project"] || args.cursorProject || ""),
      skipClientCommands: args["skip-client-commands"] === true,
      skipLaunchctl: args["skip-launchctl"] === true,
    };

    if (command === "install") {
      const installed = installSelectedClients(options);
      console.log(`Installed Token Optimizer for: ${installed.join(", ")}`);
      if (clients.includes("all") || clients.includes("cursor")) {
        console.log("Cursor MCP is configured globally; copy the generated Cursor rule into projects or pass --cursor-project for project rules.");
      }
      if (options.provider === "local") {
        console.log(`No token used. Point an OpenAI-compatible endpoint at ${options.localApiUrl || DEFAULT_LOCAL_LLM_URL} before using the tools.`);
      } else if (options.provider === "byok") {
        console.log("No proxy token used: calls are billed to your own OpenRouter account, unlimited.");
      } else if (options.provider === "skip") {
        console.log("No provider configured yet. Run `token-optimizer config` later to add a provider.");
      }
      console.log("Restart or reload each client so it picks up the MCP server and skill.");
      return;
    }

    if (command === "config") {
      applyGatewayConfig(options);
      console.log("Provider configuration written.");
      return;
    }

    if (command === "defaults") {
      applyDefaultDirectives(options);
      console.log("Default-on instructions written.");
    }
  } finally {
    rl.close();
  }
}

/* Resolves which LLM provider to configure from flags first (for scripted/CI
   use), falling back to an interactive menu only when nothing on the command
   line already decided it.
   - "gateway" needs a token (shared infrastructure, daily-limited).
   - "byok" needs ONLY your own OpenRouter key — no proxy token is asked for
     or written, because a BYOK caller doesn't use the operator's OpenRouter
     setup at all.
   - "local" needs nothing (your own endpoint, no gateway involved).
   - "skip" installs the MCP server with no provider configured at all, to be
     finished later with `token-optimizer config`. */
async function resolveProviderOptions(args, rl) {
  const explicit = normalizeProviderChoice(args.provider);
  if (explicit === "skip") {
    return { provider: "skip" };
  }
  if (explicit === "local" || args.local === true) {
    return {
      provider: "local",
      localApiUrl: args["local-url"] || args.localUrl || "",
      localModel: args["local-model"] || args.localModel || "",
    };
  }
  const byokKeyFlag = args["byok-key"] || args.byokKey;
  if (explicit === "byok" || byokKeyFlag) {
    const byokKey = byokKeyFlag || await askRequired(rl, "Your OpenRouter API key (sk-or-...): ");
    return {
      provider: "byok",
      gatewayUrl: args.url || process.env.LLM_GATEWAY_URL || DEFAULT_GATEWAY_URL,
      byokKey,
    };
  }
  if (explicit === "gateway" || args.token || process.env.LLM_GATEWAY_TOKEN) {
    const gatewayToken = args.token || process.env.LLM_GATEWAY_TOKEN || await askRequired(rl, "Gateway access token: ");
    return {
      provider: "gateway",
      gatewayToken,
      gatewayUrl: args.url || process.env.LLM_GATEWAY_URL || DEFAULT_GATEWAY_URL,
    };
  }
  return promptForProviderInteractive(args, rl);
}

async function promptForProviderInteractive(args, rl) {
  console.log("How should the LLM provider be configured?");
  console.log("  1. Gateway access token - shared infrastructure, requires an approved token, 20 calls/day by default");
  console.log("  2. Your own OpenRouter key - unlimited usage, billed to your account, NO token needed at all");
  console.log("  3. Local LLM only - your own OpenAI-compatible endpoint, no token, nothing leaves your machine");
  console.log("  4. Skip for now (configure later with `token-optimizer config`)");
  const answer = (await ask(rl, "Choice [1-4]: ")).trim();

  if (answer === "2") {
    const byokKey = await askRequired(rl, "Your OpenRouter API key (sk-or-...): ");
    console.log("No proxy token needed: calls are billed to your OpenRouter account, unlimited.");
    return { provider: "byok", gatewayUrl: args.url || process.env.LLM_GATEWAY_URL || DEFAULT_GATEWAY_URL, byokKey };
  }
  if (answer === "3") {
    const localApiUrl = (await ask(rl, `Local LLM endpoint [${DEFAULT_LOCAL_LLM_URL}]: `)).trim() || DEFAULT_LOCAL_LLM_URL;
    const localModel = (await ask(rl, `Local LLM model name [${DEFAULT_LOCAL_LLM_MODEL}]: `)).trim() || DEFAULT_LOCAL_LLM_MODEL;
    console.log("No token needed. Make sure an OpenAI-compatible endpoint is running and reachable at that URL.");
    return { provider: "local", localApiUrl, localModel };
  }
  if (answer === "4") {
    return { provider: "skip" };
  }
  const gatewayToken = await askRequired(rl, "Gateway access token: ");
  return { provider: "gateway", gatewayToken, gatewayUrl: args.url || process.env.LLM_GATEWAY_URL || DEFAULT_GATEWAY_URL };
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const eqIdx = arg.indexOf("=");
    if (eqIdx !== -1) {
      out[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function parseList(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function ask(rl, prompt) {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

async function askRequired(rl, prompt) {
  while (true) {
    const answer = (await ask(rl, prompt)).trim();
    if (answer) {
      return answer;
    }
    console.log("This value is required.");
  }
}

function printHelp() {
  console.log(`Usage:
  npx @softawarest/token-optimizer-installer [install] [options]
  token-optimizer install --clients opencode,cursor
  token-optimizer install --local
  token-optimizer config --token <token>
  token-optimizer defaults --clients claude,codex,opencode

No token is required to use this tool. With no provider flags, the installer
prompts for one of three providers, plus a skip option:

  gateway  Shared infrastructure. Requires an approved gateway access token
           (request one, then get approved). Limited to 20 calls/day by
           default (operator-adjustable).
  byok     Your own OpenRouter key. NO gateway token is used or needed at
           all — you are not using the operator's OpenRouter setup, so the
           gateway does not authenticate you, only proxies the request and
           pins the model. Unlimited usage; billed to your own account.
  local    Your own OpenAI-compatible endpoint (llama.cpp, LM Studio, Ollama,
           etc.). No token, no gateway involved, nothing leaves your machine.
  skip     Install the MCP server with no provider configured; finish later
           with \`token-optimizer config\`.

Options:
  --provider <mode>            gateway, byok, local, or skip. Overrides interactive prompting.
  --token <token>               Gateway access token. Defaults to LLM_GATEWAY_TOKEN. Implies --provider gateway.
  --url <url>                  Gateway URL. Defaults to ${DEFAULT_GATEWAY_URL}. Used by both gateway and byok modes.
  --byok-key <key>              Your own OpenRouter API key (sk-or-...). Implies --provider byok. No --token needed.
  --local                      Use a local LLM only; no token required. Implies --provider local.
  --local-url <url>             Local OpenAI-compatible endpoint. Defaults to ${DEFAULT_LOCAL_LLM_URL}.
  --local-model <name>          Local model name. Defaults to ${DEFAULT_LOCAL_LLM_MODEL}.
  --clients <list>             detected, all, claude, codex, antigravity, opencode, cursor.
  --cursor-project <path>      Copy Cursor default-on rule into a project.
  --no-defaults                Skip global default-on instruction writes.
  --skip-client-commands       Copy marketplace/plugin assets but do not invoke client CLIs.
  --skip-launchctl             Do not write macOS GUI-session gateway env values.
`);
}

main().catch((error) => {
  console.error(`Token Optimizer installer failed: ${error.message}`);
  process.exit(1);
});
