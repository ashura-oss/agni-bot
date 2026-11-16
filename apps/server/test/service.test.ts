import { describe, expect, test } from "bun:test";
import { launchdPlist, systemdUnit } from "../src/service";

const o = { bun: "/opt/b&n/bun", script: "/src/<app>/index.ts", home: "/home/a b", logPath: "/home/a b/logs/agni.log" };

test("launchd plist escapes XML and keeps the process alive", () => {
  const p = launchdPlist(o);
  expect(p).toContain("/opt/b&amp;n/bun");
  expect(p).toContain("/src/&lt;app&gt;/index.ts");
  expect(p).toContain("<key>KeepAlive</key>\n  <true/>");
  expect(p).toContain("<key>RunAtLoad</key>");
  expect(p).toContain("<string>serve</string>");
  expect(p).toContain("<key>AGNI_HOME</key>");
});

test("systemd unit quotes paths and restarts always", () => {
  const u = systemdUnit(o);
  expect(u).toContain('ExecStart="/opt/b&n/bun" "/src/<app>/index.ts" serve');
  expect(u).toContain("Restart=always");
  expect(u).toContain('Environment="AGNI_HOME=/home/a b"');
});

// --- headless vault: the passphrase file reaches the service as a systemd credential (S3-01) ---

import { passphraseServiceFile, systemdCredentialLine } from "../src/service";

test("systemd unit passes the vault passphrase file as a credential when one is configured", () => {
  const u = systemdUnit({ ...o, passphraseFile: "/etc/agni/vault pass.txt" });
  expect(u).toContain("LoadCredential=agni-vault-passphrase:/etc/agni/vault pass.txt\n");
  // Inside [Service], before [Install].
  expect(u.indexOf("LoadCredential=")).toBeGreaterThan(u.indexOf("[Service]"));
  expect(u.indexOf("LoadCredential=")).toBeLessThan(u.indexOf("[Install]"));
  // The passphrase itself is never in the unit, and the path is not given to the server as a variable.
  expect(u).not.toContain("AGNI_VAULT_PASSPHRASE_FILE");
});

test("systemd unit has no credential line without a passphrase file, and the old text is unchanged", () => {
  expect(systemdUnit(o)).not.toContain("LoadCredential");
  expect(systemdUnit({ ...o, passphraseFile: undefined })).toBe(systemdUnit(o));
});

test("the credential path escapes % for systemd specifiers and must be absolute", () => {
  expect(systemdCredentialLine("/srv/100%/pp")).toBe("LoadCredential=agni-vault-passphrase:/srv/100%%/pp");
  expect(() => systemdCredentialLine("relative/pp")).toThrow(/absolute/);
});

describe("passphraseServiceFile", () => {
  test("none when the vault does not use a passphrase", () => {
    expect(passphraseServiceFile({}, undefined)).toBeUndefined();
    expect(passphraseServiceFile({ AGNI_KEYSTORE: "bun-secrets" }, undefined)).toBeUndefined();
    expect(passphraseServiceFile({}, "bun-secrets")).toBeUndefined();
    // A vault made with the desktop store never needs the file, even if one is named.
    expect(passphraseServiceFile({ AGNI_VAULT_PASSPHRASE_FILE: "/etc/agni/pp" }, "bun-secrets")).toBeUndefined();
  });

  test("the file named by AGNI_VAULT_PASSPHRASE_FILE is passed on when the backend is the passphrase", () => {
    expect(passphraseServiceFile({ AGNI_KEYSTORE: "passphrase", AGNI_VAULT_PASSPHRASE_FILE: "/etc/agni/pp" }, undefined)).toBe("/etc/agni/pp");
    expect(passphraseServiceFile({ AGNI_VAULT_PASSPHRASE_FILE: "/etc/agni/pp" }, "passphrase")).toBe("/etc/agni/pp");
    // A file named without any other choice means a headless set-up too.
    expect(passphraseServiceFile({ AGNI_VAULT_PASSPHRASE_FILE: "/etc/agni/pp" }, undefined)).toBe("/etc/agni/pp");
  });

  test("a passphrase vault with no file named is an error, not a service that restarts forever", () => {
    expect(() => passphraseServiceFile({ AGNI_KEYSTORE: "passphrase" }, undefined)).toThrow(/AGNI_VAULT_PASSPHRASE_FILE/);
    expect(() => passphraseServiceFile({}, "passphrase")).toThrow(/AGNI_VAULT_PASSPHRASE_FILE/);
  });
});
