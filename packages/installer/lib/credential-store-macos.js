const { execFileSync: defaultExec } = require("child_process");
const { reference, secretOf } = require("./credential-store");

/* Keychain writes use Security.framework through a fixed Swift helper. The
   credential travels on stdin and therefore never appears in either the Swift
   helper argv or a nested security(1) process argv. */
function createMacOSCredentialStore(options = {}) {
  const exec = options.execFileSync || defaultExec;
  const service = options.service || "token-optimizer";
  const account = options.account;
  const args = (value) => ["find-generic-password", "-s", service, "-a", value || account || "", "-w"];
  const available = () => options.available !== undefined ? !!options.available : process.platform === "darwin";
  return {
    isAvailable: available,
    set(value) {
      const script = `import Foundation\nimport Security\nlet service = CommandLine.arguments[1]\nlet account = CommandLine.arguments[2]\nlet secret = FileHandle.standardInput.readDataToEndOfFile()\nvar item: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]\nSecItemDelete(item as CFDictionary)\nitem[kSecValueData as String] = secret\nlet status = SecItemAdd(item as CFDictionary, nil)\nexit(status == errSecSuccess ? 0 : 1)`;
      exec(options.swiftPath || "/usr/bin/swift", ["-e", script, service, account || ""], { input: secretOf(value), encoding: "utf8" });
      return reference("macos-keychain", value, { ...options, service, account });
    },
    get(value = {}) { try { return String(exec(options.securityPath || "/usr/bin/security", args(value.account), { encoding: "utf8" })).trim(); } catch (error) { if (error.status === 44 || error.code) return null; throw error; } },
    delete(value = {}) { try { exec(options.securityPath || "/usr/bin/security", ["delete-generic-password", "-s", service, "-a", value.account || account || ""], { encoding: "utf8" }); } catch (error) { if (error.status !== 44 && !error.code) throw error; } return true; },
  };
}
module.exports = { createMacOSCredentialStore };
