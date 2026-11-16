/**
 * Registers the credential migrators (S3-02) with the vault's migrator list.
 * `models/providers.ts` imports this file, and `secrets/classify.ts` (loaded by
 * `secrets/migrate.ts`, which `agni vault migrate` runs) imports
 * `models/providers.ts`, so wherever the vault migrations can run these are
 * already registered, without `secrets/` having to know about each store.
 *
 * The migrators themselves are loaded on first use: they import the plugin and
 * model stores, which import `models/providers.ts`, so loading them here would
 * be a cycle. This file imports only the registry.
 */
import { registerVaultMigrator } from "../secrets/state";
import type { Vault, VaultMigrationContext } from "../secrets/types";

const load = () => import("./migrators");

type Step = (vault: Vault, context: VaultMigrationContext) => Promise<number> | number;

/** Register one store: how to move it in and how `agni vault export` moves it back. */
function register(name: string, pick: (module: Awaited<ReturnType<typeof load>>) => { migrate: Step; export: Step }): void {
  registerVaultMigrator({
    name,
    migrate: async (vault, context) => pick(await load()).migrate(vault, context),
    export: async (vault, context) => pick(await load()).export(vault, context),
  });
}

register("provider-endpoints", (module) => ({ migrate: module.migrateProviderEndpoints, export: module.exportProviderEndpoints }));
register("plugin-secrets", (module) => ({ migrate: module.migratePluginSecrets, export: module.exportPluginSecrets }));
register("plugin-tokens", (module) => ({ migrate: module.migratePluginTokens, export: module.exportPluginTokens }));
register("chatgpt-accounts", (module) => ({ migrate: module.migrateChatgptAccounts, export: module.exportChatgptAccounts }));
