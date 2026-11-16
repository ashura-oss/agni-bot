/**
 * Running the registered migrators. S3-3 registers one per old plaintext
 * store (provider keys in `providers.json`, plugin passwords, OAuth tokens,
 * ChatGPT accounts) with `registerVaultMigrator`; this file runs them with a
 * backup directory, in order, and reports. The built-in `config-env` migrator
 * covers the credentials in `config.env`.
 */
import { join } from "node:path";
import { importEnvFileSecrets, exportEnvEntries } from "./env";
import { listVaultMigrators, registerVaultMigrator } from "./state";
import type { Vault, VaultMigrationContext } from "./types";

export interface MigrationResult {
  name: string;
  count: number;
}

/**
 * Where a migration run puts its plaintext backups: `AGNI_HOME/data/vault-backups/vault-<time>`.
 * Not `AGNI_HOME/backups`: `migrateHomeLayout` treats that old name as a layout to move into `data/`.
 */
export function newBackupDir(home: string, now = new Date()): string {
  return join(home, "data", "vault-backups", `vault-${now.toISOString().replace(/[:.]/g, "-")}`);
}

/**
 * Run every registered migrator against `vault`. A migrator that throws stops
 * the run: the migrators before it have finished (each is idempotent), the one
 * that failed left its old files in place, and the error propagates.
 */
export async function runVaultMigrations(vault: Vault, context: Omit<VaultMigrationContext, "backupDir"> & { backupDir?: string }): Promise<MigrationResult[]> {
  const full: VaultMigrationContext = { ...context, backupDir: context.backupDir ?? newBackupDir(context.home) };
  const results: MigrationResult[] = [];
  for (const migrator of listVaultMigrators()) {
    results.push({ name: migrator.name, count: await migrator.migrate(vault, full) });
  }
  return results;
}

/** Rollback: ask every migrator that can to write its entries back as plaintext. Only called after an explicit `--yes`. */
export async function runVaultExport(vault: Vault, context: Omit<VaultMigrationContext, "backupDir"> & { backupDir?: string }): Promise<MigrationResult[]> {
  const full: VaultMigrationContext = { ...context, backupDir: context.backupDir ?? newBackupDir(context.home) };
  const results: MigrationResult[] = [];
  for (const migrator of listVaultMigrators()) {
    if (migrator.export) results.push({ name: migrator.name, count: await migrator.export(vault, full) });
  }
  return results;
}

registerVaultMigrator({
  name: "config-env",
  migrate: (vault, context) => importEnvFileSecrets(vault, join(context.home, "config.env"), context.backupDir).length,
  export: (vault, context) => exportEnvEntries(vault, join(context.home, "config.env")),
});
