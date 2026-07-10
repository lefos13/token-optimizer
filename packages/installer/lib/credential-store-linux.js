const { execFileSync: defaultExec } = require("child_process");
const { reference, secretOf } = require("./credential-store");

/* secret-tool is invoked with structured arguments and stdin, avoiding shell
   interpolation while retaining compatibility with Secret Service. */
function createLinuxCredentialStore(options = {}) {
  const exec = options.execFileSync || defaultExec; const service = options.service || "token-optimizer"; const account = options.account || "";
  const bin = options.secretToolPath || "secret-tool";
  const commandExists = options.commandExists || (() => { try { exec(bin, ["--version"], { stdio: "ignore" }); return true; } catch { return false; } });
  return {
    isAvailable: () => options.available !== undefined ? !!options.available : process.platform === "linux" && !!commandExists(bin),
    set(value) { exec(bin, ["store", "--label", service, "service", service, "account", account], { input: secretOf(value), encoding: "utf8" }); return reference("linux-secret-service", value, { ...options, service, account }); },
    get() { try { return String(exec(bin, ["lookup", "service", service, "account", account], { encoding: "utf8" })).trim() || null; } catch (error) { if (error.code || error.status) return null; throw error; } },
    delete() { try { exec(bin, ["clear", "service", service, "account", account], { encoding: "utf8" }); } catch (error) { if (!error.code && !error.status) throw error; } return true; },
  };
}
module.exports = { createLinuxCredentialStore };
