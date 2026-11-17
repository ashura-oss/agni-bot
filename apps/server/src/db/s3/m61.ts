import type { Migration } from "../migrations";

/**
 * OAuth sign-in state (S3-08): one row per sign-in in flight. `state` is the
 * random value sent to the provider and is the primary key, so the callback's
 * lookup is an equality match. `code_verifier` is the PKCE secret, held only
 * here and sent only to the token endpoint. A row is deleted when it is used
 * (single use), when it expires (`expires_at`, epoch ms, ten minutes after it
 * was issued), when the same connection starts over, and when it is disconnected.
 */
export const migration: Migration | null = {
  id: 61,
  name: "oauth_states",
  sql: `
    CREATE TABLE oauth_states (
      state TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      account TEXT NOT NULL,
      code_verifier TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX idx_oauth_states_connection ON oauth_states(connection_id);
  `,
};
