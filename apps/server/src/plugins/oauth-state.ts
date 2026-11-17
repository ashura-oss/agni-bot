/**
 * Sign-in state for the OAuth flow (S3-08), in migration 61's `oauth_states`.
 *
 * A state is 256 random bits, used once, valid for ten minutes, looked up by
 * equality on the primary key (never `LIKE`), and carries the PKCE verifier that
 * only the token request may send. Starting a connection again replaces its old
 * state; disconnecting removes it. Using a state, even to find it expired or the
 * token exchange failing afterwards, deletes it.
 */
import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export interface IssuedState {
  connectionID: string;
  pluginID: string;
  account: string;
  codeVerifier: string;
}

export function newOAuthState(): string {
  return `st_${randomBytes(32).toString("base64url")}`;
}

/** Record a state for a connection; any earlier state of the same connection stops working. */
export function issueOAuthState(db: Database, issued: IssuedState & { state: string }, now: number): void {
  db.transaction(() => {
    db.run("DELETE FROM oauth_states WHERE expires_at <= ? OR connection_id = ?", [now, issued.connectionID]);
    db.run("INSERT INTO oauth_states (state, connection_id, plugin_id, account, code_verifier, expires_at) VALUES (?, ?, ?, ?, ?, ?)", [
      issued.state,
      issued.connectionID,
      issued.pluginID,
      issued.account,
      issued.codeVerifier,
      now + OAUTH_STATE_TTL_MS,
    ]);
  })();
}

/**
 * Use a state. Returns what it was issued for, or null when it is unknown, used
 * or expired. The row is deleted in the same statement that reads it, so two
 * callbacks racing on one state cannot both succeed.
 */
export function consumeOAuthState(db: Database, state: string, now: number): IssuedState | null {
  const row = db
    .query<{ connection_id: string; plugin_id: string; account: string; code_verifier: string; expires_at: number }, [string]>(
      "DELETE FROM oauth_states WHERE state = ? RETURNING connection_id, plugin_id, account, code_verifier, expires_at",
    )
    .get(state);
  if (!row || row.expires_at <= now) return null;
  return { connectionID: row.connection_id, pluginID: row.plugin_id, account: row.account, codeVerifier: row.code_verifier };
}

export function dropOAuthStates(db: Database, connectionID: string): void {
  db.run("DELETE FROM oauth_states WHERE connection_id = ?", [connectionID]);
}
