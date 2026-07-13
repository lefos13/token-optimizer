const { execFileSync: defaultExec } = require("child_process");
const { reference, secretOf } = require("./credential-store");
const MACOS_KEYCHAIN_SET_SCRIPT = `import Foundation\nimport Security\nlet service = CommandLine.arguments[1]\nlet account = CommandLine.arguments[2]\nlet secret = FileHandle.standardInput.readDataToEndOfFile()\nlet query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]\nlet status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: secret] as CFDictionary)\nvar add = query\nadd[kSecValueData as String] = secret\nlet finalStatus = status == errSecItemNotFound ? SecItemAdd(add as CFDictionary, nil) : status\nexit(finalStatus == errSecSuccess ? 0 : 1)`;

/* Keychain writes use Security.framework through a fixed Swift helper. The
   credential travels on stdin and therefore never appears in either the Swift
   helper argv or a nested security(1) process argv. */
function createMacOSCredentialStore(options = {}) {
  const exec = options.execFileSync || defaultExec;
  const service = options.service || "token-optimizer";
  const account = options.account;
  const args = (value) => ["find-generic-password", "-s", service, "-a", value || account || "", "-w"];
  const commandExists = options.commandExists || (() => { try { exec(options.swiftPath || "/usr/bin/swift", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } });
  const available = () => options.available !== undefined ? !!options.available : process.platform === "darwin" && commandExists();
  return {
    isAvailable: available,
    set(value) {
      exec(options.swiftPath || "/usr/bin/swift", ["-e", MACOS_KEYCHAIN_SET_SCRIPT, service, account || ""], { input: secretOf(value), encoding: "utf8" });
      return reference("macos-keychain", value, { ...options, service, account });
    },
    get(value = {}) { try { return String(exec(options.securityPath || "/usr/bin/security", args(value.account), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })).trim(); } catch (error) { if (error.status === 44 || error.code) return null; throw error; } },
    delete(value = {}) { try { exec(options.securityPath || "/usr/bin/security", ["delete-generic-password", "-s", service, "-a", value.account || account || ""], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch (error) { if (error.status !== 44 && !error.code) throw error; } return true; },
  };
}
module.exports = { createMacOSCredentialStore, MACOS_KEYCHAIN_SET_SCRIPT };
