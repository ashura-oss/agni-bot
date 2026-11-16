import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { agniHome } from "../home";
import { DatabaseBehindError, openDatabaseForCLI } from "../db";
import { loadConfig } from "../config";
import { isProcessAlive, pidFilePath, readPidFile } from "../daemon";
import { setEnvFileValues } from "../secrets/env";
import { runVaultExport, runVaultMigrations } from "../secrets/migrate";
import { VaultError, lockVault, unlockVault, vaultExists, vaultStatus } from "../secrets";
import { vaultRefusalMessage } from "../startup/s3-vault";
import type { CommandTable } from "./command-table";

const USAGE = `usage:
  agni vault status                 where the vault is, which keystore holds its key, whether it opens
  agni vault list                   entry names (never values)
  agni vault migrate                move plaintext credentials into the vault, then switch to vault mode (no plaintext copy is kept)
  agni vault export --yes           ROLLBACK: write every secret back to the old plaintext files and return to file mode
                                    (from a script or a service: --yes --non-interactive)`;

function fail(message: string): void {
  console.error(message);
  process.exitCode = 1;
}

async function open(create: boolean) {
  try {
    return await unlockVault({ create });
  } catch (error) {
    fail(error instanceof VaultError ? vaultRefusalMessage(error) : String(error));
    return undefined;
  }
}

async function status(): Promise<void> {
  const info = vaultStatus();
  console.log(`vault:     ${info.path}`);
  console.log(`exists:    ${info.exists ? "yes" : "no"}`);
  console.log(`mode:      ${info.mode}${info.mode === "file" ? " (credentials still load from config.env; run `agni vault migrate`)" : ""}`);
  if (!info.exists) return;
  console.log(`format:    version ${info.version ?? "unreadable"}, keystore ${info.keystoreKind ?? "unreadable"}`);
  const vault = await open(false);
  if (!vault) return;
  console.log(`unlocks:   yes (${vault.list().length} entries)`);
}

async function list(): Promise<void> {
  const vault = await open(false);
  if (!vault) return;
  for (const entry of vault.list()) console.log(`${entry.name}  (updated ${entry.updatedAt || "unknown"})`);
  if (vault.list().length === 0) console.log("the vault is empty");
}

/**
 * The database, when there is one: some migrators (OAuth tokens) need it. A home
 * with no database yet has nothing in it to move, so that is not an error. A
 * database that exists but cannot be opened is: carrying on without it would
 * leave OAuth tokens in the clear while the home switches to vault mode. A
 * database that is behind says so and names `agni migrate`.
 */
export function optionalDatabase(path: string = loadConfig().dbPath) {
  if (!existsSync(path)) return undefined;
  try {
    return openDatabaseForCLI(path);
  } catch (error) {
    if (error instanceof DatabaseBehindError) {
      throw new Error(
        `the database at ${path} is behind this version (missing migration ${error.missing.join(", ")}), so its OAuth tokens cannot be moved. ` +
          "Run `agni migrate`, then run this command again.",
        { cause: error },
      );
    }
    throw new Error(`the database at ${path} could not be opened (${error instanceof Error ? error.message : String(error)}), so its OAuth tokens cannot be moved.`, { cause: error });
  }
}

/**
 * `migrate` and `export` rewrite the database file and the credential files, and a
 * running daemon holds both open (and would keep serving the old values from memory).
 * A refusal, or undefined when no live daemon is recorded. Read-only: the pid file
 * and a liveness probe; nothing is signalled.
 */
export function daemonRunningRefusal(pidPath: string = pidFilePath(loadConfig())): string | undefined {
  const info = readPidFile(pidPath);
  if (!info || !isProcessAlive(info.pid)) return undefined;
  return `the Agni daemon is running (pid ${info.pid}), so stop the daemon first: run \`agni daemon stop\`, then run this command again.`;
}

async function migrate(): Promise<void> {
  const running = daemonRunningRefusal();
  if (running) return fail(`migration not started: ${running}`);
  // The database first: a refusal there must not leave a new, empty vault behind.
  let db: ReturnType<typeof optionalDatabase>;
  try {
    db = optionalDatabase();
  } catch (error) {
    return fail(`migration not started: ${error instanceof Error ? error.message : String(error)}`);
  }
  const vault = await open(true);
  if (!vault) {
    db?.close();
    return;
  }
  const home = agniHome();
  try {
    const results = await runVaultMigrations(vault, { home, db });
    for (const { name, count } of results) console.log(`${name}: ${count} moved`);
    // Only after every migrator finished: from now on credentials come from the vault.
    setEnvFileValues(join(home, "config.env"), { AGNI_SECRETS_MODE: "vault" });
    console.log("done. config.env keeps only the non-secret settings; the credentials are in vault.bin, encrypted. No plaintext copy was kept.");
    console.log("to undo it: agni vault export --yes");
    console.log("restart the daemon to apply: agni daemon restart");
  } catch (error) {
    fail(`migration stopped: ${error instanceof Error ? error.message : String(error)}\nThe old files were left in place. Run it again after fixing the cause.`);
  } finally {
    db?.close();
  }
}

/** True when a person can answer at this terminal. */
const interactive = (): boolean => process.stdin.isTTY === true;

/**
 * A file-mode start opens any `vault.bin` it finds, which needs the keystore.
 * Setting the file aside makes the rollback complete. Renamed, not deleted: it
 * is still encrypted, and it is the only copy if the export missed something.
 */
function setVaultAside(path: string): string {
  lockVault();
  const kept = `${path}.exported-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  renameSync(path, kept);
  return kept;
}

async function exportSecrets(args: string[]): Promise<void> {
  if (!args.includes("--yes")) {
    fail(
      "agni vault export writes every secret in the vault back to plaintext files (config.env and the other old stores).\n" +
        "That undoes the encryption. Run `agni vault export --yes` if you mean it.",
    );
    return;
  }
  // A script, a pipe or a service cannot read a warning, so it has to say so explicitly.
  if (!interactive() && !args.includes("--non-interactive")) {
    fail(
      "agni vault export is not running at a terminal, so nobody can see what it is about to do (it writes every secret back to plaintext).\n" +
        "Run it from a terminal, or add --non-interactive if a script really means it: agni vault export --yes --non-interactive",
    );
    return;
  }
  const running = daemonRunningRefusal();
  if (running) return fail(`export not started: ${running}`);
  if (!vaultExists()) {
    fail("there is no vault to export.");
    return;
  }
  let db: ReturnType<typeof optionalDatabase>;
  try {
    db = optionalDatabase();
  } catch (error) {
    return fail(`export not started: ${error instanceof Error ? error.message : String(error)}`);
  }
  const vault = await open(false);
  if (!vault) {
    db?.close();
    return;
  }
  const home = agniHome();
  try {
    for (const { name, count } of await runVaultExport(vault, { home, db })) console.log(`${name}: ${count} written`);
    setEnvFileValues(join(home, "config.env"), { AGNI_SECRETS_MODE: "file" });
    console.log("exported. Credentials are plaintext again and Agni is back in file mode; restart the daemon to apply.");
    const path = vaultStatus().path;
    try {
      console.log(`the encrypted vault was renamed to ${setVaultAside(path)}; delete it (and its key in the credential store) when you no longer want it.`);
    } catch (error) {
      fail(`the secrets are exported, but ${path} could not be renamed (${error instanceof Error ? error.message : String(error)}). Rename or delete it yourself, or file-mode starts will still try to open it.`);
    }
  } catch (error) {
    fail(`export stopped: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    db?.close();
  }
}

async function vault(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === "status") return status();
  if (sub === "list") return list();
  if (sub === "migrate") return migrate();
  if (sub === "export") return exportSecrets(rest);
  fail(USAGE);
}

/** CLI commands for s3-vault. */
export const s3VaultCommands: CommandTable = {
  commands: { vault },
  help: [
    "  vault status|list|migrate|export   the encrypted secrets vault (export --yes = rollback to plaintext)",
  ],
};
