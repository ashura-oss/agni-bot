/**
 * What the main column shows when the address names something that is not
 * there: a bot, a group or a task that does not exist, or a page that never
 * did. The address is left as it was, so a typo can be fixed in the bar.
 */
import { Menu } from "lucide-react";
import { useAppModel, useAppSnapshot } from "../state/use-app-model";

const TITLES = {
  bot: "Bot not found",
  group: "Group not found",
  task: "Task not found",
  page: "Page not found",
} as const;

export function NotFoundView({ onToggleSidebar }: { onToggleSidebar?: () => void }) {
  const model = useAppModel();
  const snapshot = useAppSnapshot();
  const missing = snapshot.notFound;
  if (!missing) return null;
  const first = snapshot.agents[0];
  return (
    <main className="chat-main route-state" aria-labelledby="route-state-title">
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
      <div className="route-state-body">
        <h1 id="route-state-title">{TITLES[missing.what]}</h1>
        <p>
          Nothing lives at <code className="machine route-state-path">{missing.path}</code>.
          {missing.what === "page" ? "" : " It may have been deleted, or the link may be mistyped."}
        </p>
        {first ? (
          <button type="button" className="btn primary" onClick={() => model.selectAgent(first)}>
            Back to {first.name}
          </button>
        ) : null}
      </div>
    </main>
  );
}
