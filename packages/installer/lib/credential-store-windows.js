const { execFileSync: defaultExec } = require("child_process");
const fs = require("fs"); const path = require("path");
const { reference, secretOf } = require("./credential-store");

/* DPAPI ciphertext is kept in a private installer data directory. The
   PowerShell script is passed as one argv value; tests inject the process
   adapter and therefore never invoke a real user profile. */
function createWindowsCredentialStore(options = {}) {
  const exec = options.execFileSync || defaultExec; const filePath = path.resolve(options.path || path.join(options.home || process.env.USERPROFILE || process.cwd(), ".token-optimizer", "credential.dpapi"));
  const bin = options.powershellPath || "powershell.exe";
  const run = (script, input) => exec(bin, ["-NoProfile", "-NonInteractive", "-Command", script], { input, encoding: "utf8" });
  return {
    isAvailable: () => options.available !== undefined ? !!options.available : process.platform === "win32",
    set(value) { const encoded = run("[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))", secretOf(value)).toString().trim(); fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, encoded, { mode: 0o600 }); try { fs.chmodSync(filePath, 0o600); } catch {} return reference("windows-dpapi", value, options); },
    get() { if (!fs.existsSync(filePath)) return null; return run("[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String([Console]::In.ReadToEnd()),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))", fs.readFileSync(filePath, "utf8")).toString(); },
    delete() { fs.rmSync(filePath, { force: true }); return true; },
  };
}
module.exports = { createWindowsCredentialStore };
