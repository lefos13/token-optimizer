const { execFileSync: defaultExec } = require("child_process");
const { reference, secretOf } = require("./credential-store");

/* The security utility receives an argv array, while the password is supplied
   through stdin so it cannot appear in process listings or audit argv data. */
function createMacOSCredentialStore(options = {}) {
  const exec = options.execFileSync || defaultExec;
  const service = options.service || "token-optimizer";
  const account = options.account;
  const args = (value) => ["find-generic-password", "-s", service, "-a", value || account || "", "-w"];
  const available = () => options.available !== undefined ? !!options.available : process.platform === "darwin";
  return {
    isAvailable: available,
    set(value) { exec(options.securityPath || "/usr/bin/security", ["add-generic-password", "-U", "-s", service, "-a", account || "", "-w"], { input: secretOf(value), encoding: "utf8" }); return reference("macos-keychain", value, { ...options, service, account }); },
    get(value = {}) { try { return String(exec(options.securityPath || "/usr/bin/security", args(value.account), { encoding: "utf8" })).trim(); } catch (error) { if (error.status === 44 || error.code) return null; throw error; } },
    delete(value = {}) { try { exec(options.securityPath || "/usr/bin/security", ["delete-generic-password", "-s", service, "-a", value.account || account || ""], { encoding: "utf8" }); } catch (error) { if (error.status !== 44 && !error.code) throw error; } return true; },
  };
}
module.exports = { createMacOSCredentialStore };
