/**
 * The one place a lost connection is said out loud. A 6px dot is easy to miss
 * while the header still looks alive, so when the socket is not ready a band
 * under the header says what is happening and what the owner can do. It is a
 * polite live region: a screen reader hears the change once, not every tick.
 */
import { WifiOff } from "lucide-react";
import type { ConnectionState } from "@agni/client";
import { useAppModel, useAppSnapshot } from "../state/use-app-model";

export function connectionBannerText(state: ConnectionState): string | null {
  switch (state.kind) {
    case "ready":
      return null;
    case "idle":
    case "connecting":
    case "handshaking":
      return "Connecting to the Agni server…";
    case "waiting":
      return `Connection lost. Reconnecting (attempt ${state.attempt}), trying again in about ${Math.max(1, Math.round(state.seconds))}s.`;
    case "refused":
      return state.reason;
    case "stopped":
      return "Disconnected from the Agni server.";
  }
}

export function ConnectionBanner() {
  const model = useAppModel();
  const snapshot = useAppSnapshot();
  const state = snapshot.connectionState;
  const text = connectionBannerText(state);
  if (text === null) return null;
  const lost = state.kind === "waiting" || state.kind === "refused" || state.kind === "stopped";
  return (
    <div className={`connection-banner${lost ? " lost" : ""}`} role="status" aria-live="polite">
      <WifiOff size={14} aria-hidden="true" />
      <span className="connection-banner-text">{text}</span>
      {state.kind === "waiting" ? (
        <button type="button" className="btn small" onClick={() => model.retryNow()}>
          Retry now
        </button>
      ) : null}
      {state.kind === "refused" ? (
        <button type="button" className="btn small" onClick={() => model.editConnection()}>
          Connection settings
        </button>
      ) : null}
    </div>
  );
}
