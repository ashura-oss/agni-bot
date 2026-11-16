import type { Migration } from "../migrations";

/**
 * Credential references (S3-02). In vault mode a connection's OAuth tokens live
 * in the vault, and the row names them here (`plugin-token/<connection id>`)
 * instead of holding them in `tokens`. The schema change is only the new
 * column; moving the tokens needs the vault, which SQL cannot open, so
 * `agni vault migrate` does it (credentials/migrators.ts): copy, read back, and
 * only then empty `tokens` and set `token_ref`. Nothing here touches a token.
 */
export const migration: Migration | null = {
  id: 62,
  name: "plugin_connection_token_refs",
  sql: `
    ALTER TABLE plugin_connections ADD COLUMN token_ref TEXT;
  `,
};
