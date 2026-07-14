/* Provider-selection tests require a deterministic empty host environment.
   Individual tests opt into the exact credential variables they exercise, so
   developer or CI credentials cannot silently change their provider mode. */
const { spawnSync } = require("child_process");
const path = require("path");

const env = { ...process.env };
for (const key of ["LLM_GATEWAY_URL", "LLM_GATEWAY_TOKEN", "OPENROUTER_BYOK_KEY", "OPENROUTER_API_KEY", "OPENROUTER_API_URL", "OPENROUTER_MODEL", "TOKEN_OPTIMIZER_PROVIDER_MODE", "TOKEN_OPTIMIZER_CREDENTIAL_REF", "LOCAL_LLM_API_URL", "LOCAL_LLM_MODEL"]) {
  delete env[key];
}
const result = spawnSync(process.execPath, ["--test", ...process.argv.slice(2)], {
  cwd: path.join(__dirname, "..", ".test-build"),
  env,
  stdio: "inherit",
});
process.exit(result.status == null ? 1 : result.status);
