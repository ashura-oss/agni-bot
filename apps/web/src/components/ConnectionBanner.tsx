/**
 * The one place a lost connection is said out loud. A 6px dot is easy to miss
 * while the header still looks alive, so when the socket is not ready a band
 * under the header says what is happening and what the owner can do.
 *
 * Two things keep it quiet. The first connect of a page load is not shown
 * unless it takes longer than two seconds. And the band itself is not a live
 * region: a separate, hidden one announces only the move to "lost" and the
 * move back to "connected", not every retry or handshake step in between.
 */
import { useEffect, useState } from "react";
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

/** How long a first connect may take before the owner is told about it. */
const SLOW_CONNECT_MS = 2000;

export function ConnectionBanner() {
  const model = useAppModel();
  const snapshot = useAppSnapshot();
  const state = snapshot.connectionState;
  const ready = state.kind === "ready";
  const lostNow = state.kind === "waiting" || state.kind === "refused";
  // True from the moment a connection is lost until it is back.
  const [lost, setLost] = useState(lostNow);
  const [slow, setSlow] = useState(false);
  const [announcement, setAnnouncement] = useState(lostNow ? LOST : "");

  useEffect(() => {
    if (ready) {
      if (lost) {
        setLost(false);
        setAnnouncement(BACK);
      }
      setSlow(false);
      return;
    }
    if (lostNow && !lost) {
      setLost(true);
      setAnnouncement(LOST);
    }
    const timer = setTimeout(() => setSlow(true), SLOW_CONNECT_MS);
    return () => clearTimeout(timer);
  }, [ready, lostNow, lost]);

  const text = connectionBannerText(state);
  const visible = text !== null && (lost || lostNow || slow);
  return (
    <>
      <div className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </div>
      {visible ? (
        <div className={`connection-banner${lost || lostNow ? " lost" : ""}`}>
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
      ) : null}
    </>
  );
}

const LOST = "Connection lost. Reconnecting.";
const BACK = "Connected again.";
