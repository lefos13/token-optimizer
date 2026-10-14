---
name: token-optimizer-setup
description: Installs, configures, verifies, and repairs the Token Optimizer MCP server for the user's coding client, choosing between the user's own OpenRouter key and a local OpenAI-compatible model. Use it only when the user asks to set up, reconfigure, switch the provider of, upgrade, or troubleshoot Token Optimizer.
disable-model-invocation: true
---

# Token Optimizer setup

Guide the user through installing and verifying the `token_optimizer` MCP
server. You run read-only checks yourself; anything that changes the machine
is proposed first and run only after the user agrees. End every path with a
short checklist of what the user still has to do.

The installer is the npm package `@softawarest/token-optimizer-installer`.
Run it from a normal directory such as the home folder, not from inside a
Token Optimizer source checkout. Below, `INSTALLER` means
`npx --yes @softawarest/token-optimizer-installer`.

## 1. Inspect (read-only, no consent needed)

1. `node --version` — Node.js 18 or newer is required (current LTS recommended), and `npm` must be on
   `PATH`. If missing, stop and tell the user to install Node.js LTS.
2. Identify the client you are running in (Claude Code, Codex, Cursor,
   Antigravity, or OpenCode).
3. `INSTALLER status --json` — shows installed clients, version, and the
   configured provider. It makes no network requests and changes nothing.
4. If something is already installed, run `INSTALLER doctor --json` and use
   the troubleshooting table below.

## 2. Interview the user

Ask these questions one at a time, unless the user already answered them.
Explain each option in plain words so the user knows what they are agreeing
to. Respect their choice, including `unrestricted`.

### Q1. Which model provider?

- **OpenRouter (own key)**: small, cheap hosted models billed to their own
  OpenRouter account. Prompts are redacted before they leave the machine.
- **Local LLM**: any OpenAI-compatible server (llama.cpp, LM Studio,
  Ollama's `/v1` API). Nothing leaves the machine.

**OpenRouter: never handle the key yourself.** Never ask for the API key in
the conversation, never echo it, and never put it on a command line you run:
conversation transcripts and shell history would capture it. Offer one of:

- **A.** Finish Q2-Q5 first, then give the user the complete install
  command (`--provider openrouter` plus the flags from their answers) to run
  in their own terminal. The installer prompts for the key there and stores it
  in the OS credential store. Continue with Q3's `allow` commands and step 4.
- **B.** The user adds `export OPENROUTER_API_KEY=...` to the shell profile
  used by the client and restarts it. You then use
  `--provider openrouter --credential-store env`.

An optional model can be pinned with `--openrouter-model <provider/model>`;
the default is `openai/gpt-4o-mini`.

**Local: verify the endpoint first.** Ask for the URL (default
`http://localhost:8080/v1`) and check it with `curl -s <url>/models`. If it
fails, tell the user to start their local server and stop. Pick a model id
from the response together. You then use
`--provider local --local-url <url> --local-model <model>`.

### Q2. Which commands may Token Optimizer run for the agent?

Explain the three execution profiles:

| Profile | What the agent may run |
| --- | --- |
| `standard` (recommended) | The project's own build/test/lint scripts, common test runners and linters (vitest, jest, pytest, cargo, go, tsc, eslint, ruff, ...), and read-only inspection (git status/log/diff, ls, grep, cat). Nothing that installs packages, edits files in place, or runs arbitrary scripts. |
| `safe` | Only command prefixes the user allows explicitly. |
| `unrestricted` | Any command the agent asks for. A malicious repository or a prompt injection could then run any program with the user's privileges. Recommend it only for repositories they trust. |

In every profile the server still blocks command chaining, pipes,
redirection, network tools, nested shells, destructive commands, secret files
(`.env`, keys), environment variables, and paths outside the workspace. Say
so, so the user knows `unrestricted` is not a full bypass.

If the user picks `unrestricted`, restate the risk in one sentence and ask
them to confirm. Once they confirm, use it. Use `--profile <name>`.

### Q3. Any extra commands to allow?

Only for `standard` or `safe`. Ask whether there are commands they want the
agent to run that the profile does not cover (for example `npm install`,
`make test`, `docker compose ps`). Each becomes a prefix: a command is allowed
when it equals the prefix or starts with it plus a space. Run
`INSTALLER allow "<prefix>"` once per prefix after installing.

### Q4. Use Token Optimizer by default?

By default the installer adds a short block to the client's global agent
instructions (for example `~/.claude/CLAUDE.md`) telling the agent to prefer
Token Optimizer for builds, tests, and log triage. If the user does not want
that, add `--no-defaults`.

### Q5. Which clients?

Default: the client you are running in (`--clients <client>`). Offer `all`
detected clients if the user uses several. Cursor only: add
`--cursor-project <absolute project path>` to copy the project rules.

## 3. Apply

1. Summarize the answers back to the user as one list: provider, profile,
   extra allowed prefixes, default-on yes/no, clients.
2. Show the plan: run the install command with `--dry-run` and summarize the
   files it would write.
3. After the user agrees, run the same command without `--dry-run`, then any
   `INSTALLER allow "<prefix>"` commands from Q3.

The user can change these later without reinstalling:
`INSTALLER profile <safe|standard|unrestricted>`, `INSTALLER allow "<prefix>"`,
`INSTALLER allow --list`, and `INSTALLER allow --remove "<prefix>"`. Policy
changes apply on the next tool call; no restart is needed.

## 4. Verify

1. Tell the user to fully restart the client; MCP servers load at startup.
2. After the restart, call `check_local_llm_health`. `available: true` means
   the provider answers.
3. Run one cheap smoke check, for example `run_test_verdict` with
   `testCommand: "node --version"` and the absolute `workspacePath`.

## Troubleshooting

| Symptom or `doctor` code | What to do |
| --- | --- |
| Tools missing after install | Fully restart the client. Then run `INSTALLER doctor`. |
| `CLIENT_NOT_CONFIGURED`, `MISSING_LAUNCHER`, `STALE_REGISTRATION`, `DUPLICATE_REGISTRATION`, `MANIFEST_*` | Propose `INSTALLER repair --dry-run`, then `INSTALLER repair`. |
| `DEPENDENCY_CACHE_INCOMPLETE` | Restart the client; the launcher reinstalls its single dependency (needs network once). |
| `PROVIDER_MISSING` | No provider is configured: go back to step 2 and use `INSTALLER config ...` with the same provider flags. |
| `CREDENTIAL_MISSING`, `CREDENTIAL_INACCESSIBLE`, `PROVIDER_AUTH_FAILED` | The OpenRouter key is absent or rejected. The user re-enters it with option A or B above. |
| `PROVIDER_UNREACHABLE` | Local: start the local server and re-check `<url>/models`. OpenRouter: check connectivity. |
| `LEGACY_GATEWAY_CONFIG` | The old shared gateway was retired. Run `INSTALLER install` again; a previous OpenRouter key migrates automatically, otherwise choose a provider. |
| `VERSION_MISMATCH` | Run `INSTALLER install` again to update, then restart the client. |
| A tool returns `executionStatus: blocked` | Read `policyHint`. For `COMMAND_NOT_ALLOWED`, ask the user whether to allow it; with consent run its `allowCommand`. Other reason codes are blocked in every profile: rewrite the command (drop pipes and chaining, use `testCommands`). |
| `check_local_llm_health` returns `available: false` | Read its `error`; for local, confirm the model id exists in `<url>/models`. |

To remove everything: `INSTALLER uninstall --dry-run`, then `INSTALLER
uninstall` after the user agrees.

## Finish with a checklist

Always end with what the user must still do, for example:

- [ ] Restart the client.
- [ ] Keep the local LLM server running while using Token Optimizer.
- [ ] Ask the agent to use Token Optimizer for builds, tests, and log triage.
