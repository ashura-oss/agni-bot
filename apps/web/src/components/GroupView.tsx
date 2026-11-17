/**
 * A group channel's page, reached from `/group/<id>`: its name and members,
 * each member a way into that bot's own conversation. The group's messages
 * are not drawn here yet; the daemon already keeps them (`channel.history`).
 */
import { Menu } from "lucide-react";
import { useAppModel, useAppSnapshot } from "../state/use-app-model";
import { SidebarAgentBadge } from "./bits";

export function GroupView({ groupID, onToggleSidebar }: { groupID: string; onToggleSidebar?: () => void }) {
  const model = useAppModel();
  const snapshot = useAppSnapshot();
  const group = snapshot.groups?.find((candidate) => candidate.id === groupID) ?? null;
  const everyone = [...snapshot.mentionAgents, ...snapshot.agents];
  const members = (group?.agentIds ?? []).map((id) => everyone.find((agent) => agent.id === id) ?? null);
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
        <h1 id="route-state-title">{group ? group.name : "Group"}</h1>
        {group ? (
          <>
            <p>{group.agentIds.length} bots share this group. The first answers unless another is named.</p>
            <ul className="group-members" aria-label="Members">
              {group.agentIds.map((id, index) => {
                const agent = members[index] ?? null;
                return (
                  <li key={id}>
                    {agent ? (
                      <button type="button" className="group-member" aria-label={`Open ${agent.name} chat`} onClick={() => model.selectAgent(agent)}>
                        <SidebarAgentBadge agent={agent} size={32} />
                        <span>{agent.name}</span>
                      </button>
                    ) : (
                      <span className="group-member unknown">{id}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        ) : (
          <p role="status">Loading the group…</p>
        )}
      </div>
    </main>
  );
}
