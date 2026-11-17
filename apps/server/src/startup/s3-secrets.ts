import { log } from "../log";
import { registerStoredConnectionSecrets } from "../plugins/store";
import { registerProxyPasswords } from "../util/proxy-env";
import type { StartupContext } from "./context";

/**
 * Mask what the stores already hold, before anything is logged, sent or stored: the OAuth tokens of every plugin
 * connection row (file mode: the `tokens` column; vault mode: the blob in the vault, whose inner tokens the vault
 * itself does not register). `plugins.json` is registered by `loadPluginsFile`, which the plugin service runs when it is made.
 * The password in a proxy address (`HTTPS_PROXY=http://user:password@...`) is masked too: the server keeps the address, a shell child
 * does not (`util/child-env.ts`), but a failed request's error text names it.
 * Runs after the vault is open (`serve()` opens it before the hooks), so a vault-held blob can be read.
 */
export async function startupS3Secrets(ctx: StartupContext): Promise<void> {
  registerProxyPasswords(process.env);
  const rows = registerStoredConnectionSecrets(ctx.db);
  if (rows > 0) log.info(`secrets: masking the stored tokens of ${rows} plugin connection(s)`);
}
