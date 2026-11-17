/**
 * Who is on the roster before the daemon has said, and what a new bot is
 * called. Pure helpers: no model, no window.
 */
import type { AgentInfo } from "@agni/client";

const PRIMARY_AGENTS = new Set(["ea", "agni"]);
export function isPrimaryAgent(agent: AgentInfo | null | undefined): boolean {
  return !agent || PRIMARY_AGENTS.has(agent.id);
}

export function seedAgents(): AgentInfo[] {
  return [{ id: "ea", name: "New Bot", color: "#f0b95a", tools: [] }];
}

/** What the "+" button makes: an agent with a placeholder name, not a form. */
const NEW_AGENT_NAME = "New bot";
export const NEW_AGENT_PROMPT = `You are {name}, an agent {user} just created in the app. You have no job description yet.

Open with one short line, then ask what you should do for them.
You cannot rename yourself. If they want to call you something else, tell them to change your name in your profile (the name at the top of this chat) and carry on.
When they describe your job, call update_agent with a short role and a prompt written as instructions to yourself.
Until then, answer what is asked, briefly.`;

/** The slug the daemon derives from a name, so both sides land on one id. */
function agentSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "agent";
}

/**
 * The name and id for the next placeholder bot: "New bot", then "New bot 2",
 * and so on past any the roster already has — including ones renamed since,
 * whose id still holds the slot.
 */
export function nextNewAgent(known: readonly AgentInfo[]): { id: string; name: string } {
  const takenIDs = new Set(known.map((agent) => agent.id));
  const takenNames = new Set(known.map((agent) => agent.name.trim().toLowerCase()));
  let name = NEW_AGENT_NAME;
  for (let n = 2; takenIDs.has(agentSlug(name)) || takenNames.has(name.toLowerCase()); n += 1) {
    name = `${NEW_AGENT_NAME} ${n}`;
  }
  return { id: agentSlug(name), name };
}
