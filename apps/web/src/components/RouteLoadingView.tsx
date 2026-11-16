/**
 * What the main column shows while the address cannot be resolved yet: the daemon has not sent the bot
 * roster (a fresh load, or a browser that was away past the replay window). Showing the seed bot's thread
 * instead would put a message in the wrong chat.
 */
import { Menu } from "lucide-react";
import { useAppModel, useAppSnapshot } from "../state/use-app-model";
import { ConnectionBanner } from "./ConnectionBanner";

export function RouteLoadingView({ onToggleSidebar }: { onToggleSidebar?: () => void }) {
  const model = useAppModel();
  // Not connected yet, the roster cannot come: say what is being waited for.
  const connected = useAppSnapshot().connectionState.kind === "ready";
  return (
    <main className="chat-main route-state" aria-busy="true">
      <header className="route-state-bar">
        <button
          type="button"
          className="icon-btn header-menu"
          aria-label="Open the agent list"
          onClick={() => { if (typeof matchMedia !== "undefined" && matchMedia("(min-width: 721px)").matches) onToggleSidebar?.(); else model.openSidebar(); }}
        >
          <Menu size={17} />
        </button>
      </header>
      <ConnectionBanner />
      <div className="route-state-body">
        <p role="status" aria-label="Loading" className="route-state-loading">{connected ? "Loading…" : "Waiting for the daemon…"}</p>
      </div>
    </main>
  );
}
