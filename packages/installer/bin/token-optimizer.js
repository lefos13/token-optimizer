#!/usr/bin/env node

const readline = require("readline");
const {
  DEFAULT_GATEWAY_URL,
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
    const gatewayToken = args.token || process.env.LLM_GATEWAY_TOKEN || await askRequired(rl, "Gateway access token: ");
    const gatewayUrl = args.url || process.env.LLM_GATEWAY_URL || DEFAULT_GATEWAY_URL;
    const defaults = args.defaults !== "false" && args["no-defaults"] !== true;
    const options = {
      clients,
      gatewayToken,
      gatewayUrl,
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
      console.log("Restart or reload each client so it picks up the MCP server and skill.");
      return;
    }

    if (command === "config") {
      applyGatewayConfig(options);
      console.log("Gateway configuration written.");
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
  token-optimizer config --token <token>
  token-optimizer defaults --clients claude,codex,opencode

Options:
  --token <token>              Gateway access token. Defaults to LLM_GATEWAY_TOKEN.
  --url <url>                  Gateway URL. Defaults to ${DEFAULT_GATEWAY_URL}.
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
