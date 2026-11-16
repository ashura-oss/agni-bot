/**
 * The app's addresses. Pure: it reads and writes paths, and says whether the
 * thing a path names exists. It never touches `window`; the model does that.
 *
 *   /agent/<id>              a bot's conversation
 *   /group/<id>              a group channel
 *   /task/<id>               one task, open on the Tasks screen
 *   /tasks[/<view>]          the Tasks screen (today, inbox, upcoming, ...); an unknown view is not found
 *   /settings[/<section>]    Settings, over whatever is behind it
 *
 * Anything else keeps its address and shows a not-found state.
 */
import type { AgentInfo, TaskInfo } from "@agni/client";
import type { ChannelInfo } from "@agni/protocol";

export const SETTINGS_SECTIONS = ["general", "appearance", "plugins", "approvals", "models", "device"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export type TaskViewRoute = { kind: "today" | "inbox" | "upcoming" | "calendar" | "completed" | "list"; listID?: string };

export type Route =
  | { kind: "root" }
  | { kind: "agent"; id: string }
  | { kind: "group"; id: string }
  | { kind: "task"; id: string }
  | { kind: "tasks"; view: TaskViewRoute }
  | { kind: "settings"; section: SettingsSection | null }
  | { kind: "not-found"; path: string };

const TASK_VIEWS = ["inbox", "upcoming", "calendar", "completed"] as const;

export function isSettingsSection(value: string | undefined): value is SettingsSection {
  return (SETTINGS_SECTIONS as readonly string[]).includes(value ?? "");
}

/** Read an address. A path that names no screen comes back as `not-found`, with the path kept. */
export function parseRoute(pathname: string): Route {
  const missing: Route = { kind: "not-found", path: pathname };
  let parts: string[];
  try {
    parts = pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  } catch {
    return missing;
  }
  const [head, second, third] = parts;
  if (head === undefined) return { kind: "root" };
  if (head === "agent" || head === "group" || head === "task") {
    return second !== undefined && parts.length === 2 ? { kind: head, id: second } : missing;
  }
  if (head === "settings") {
    if (parts.length === 1) return { kind: "settings", section: null };
    return parts.length === 2 && isSettingsSection(second) ? { kind: "settings", section: second } : missing;
  }
  if (head === "tasks") {
    if (second === undefined || (second === "today" && parts.length === 2)) return { kind: "tasks", view: { kind: "today" } };
    if (parts.length === 2 && (TASK_VIEWS as readonly string[]).includes(second)) {
      return { kind: "tasks", view: { kind: second as (typeof TASK_VIEWS)[number] } };
    }
    if (parts.length === 3 && second === "collection" && third) return { kind: "tasks", view: { kind: "list", listID: third } };
    return missing;
  }
  return missing;
}

/** The address a route lives at; `parseRoute(routePath(route))` gives the route back. */
export function routePath(route: Route): string {
  switch (route.kind) {
    case "root": return "/";
    case "agent": return `/agent/${encodeURIComponent(route.id)}`;
    case "group": return `/group/${encodeURIComponent(route.id)}`;
    case "task": return `/task/${encodeURIComponent(route.id)}`;
    case "settings": return route.section ? `/settings/${route.section}` : "/settings";
    case "not-found": return route.path;
    case "tasks": {
      const { view } = route;
      if (view.kind === "list") return `/tasks/collection/${encodeURIComponent(view.listID ?? "lst_inbox")}`;
      return view.kind === "today" ? "/tasks" : `/tasks/${view.kind}`;
    }
  }
}

/**
 * A bot's address is its id: it never changes when the bot is renamed, and no
 * two bots share one. (Names change and can collide, which left `/agent/new-bot`
 * pointing at the wrong bot after a rename or a second "New bot".)
 */
export function agentPath(agent: AgentInfo | null): string {
  return routePath({ kind: "agent", id: agent?.id ?? "ea" });
}

/** The bot a `/agent/<key>` address names: by id, else by a name nobody else shares (old links). */
export function agentForRoute(key: string, roster: readonly AgentInfo[]): AgentInfo | null {
  const wanted = key.toLowerCase();
  const byID = roster.find((agent) => agent.id.toLowerCase() === wanted);
  if (byID) return byID;
  const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const byName = roster.filter((agent) => slug(agent.name) === wanted);
  return byName.length === 1 ? (byName[0] ?? null) : null;
}

/** What the app knows now, to check an address against. `null` / `false` mean "not heard yet". */
export interface RouteKnowledge {
  rosterKnown: boolean;
  agents: readonly AgentInfo[];
  groups: readonly Pick<ChannelInfo, "id">[] | null;
  tasks: readonly Pick<TaskInfo, "id">[];
  tasksKnown: boolean;
}

export type RouteResolution =
  | { kind: "found" }
  /** The thing may still turn up once the daemon has answered. */
  | { kind: "pending" }
  | { kind: "missing"; what: "bot" | "group" | "task" | "page"; path: string };

/** Does the thing this address names exist? Only a daemon that has answered can say it does not. */
export function resolveRoute(route: Route, known: RouteKnowledge): RouteResolution {
  switch (route.kind) {
    case "agent":
      if (agentForRoute(route.id, known.agents)) return { kind: "found" };
      return known.rosterKnown ? { kind: "missing", what: "bot", path: routePath(route) } : { kind: "pending" };
    case "group":
      if (known.groups === null) return { kind: "pending" };
      return known.groups.some((group) => group.id === route.id) ? { kind: "found" } : { kind: "missing", what: "group", path: routePath(route) };
    case "task":
      if (known.tasks.some((task) => task.id === route.id)) return { kind: "found" };
      return known.tasksKnown ? { kind: "missing", what: "task", path: routePath(route) } : { kind: "pending" };
    case "not-found":
      return { kind: "missing", what: "page", path: route.path };
    default:
      return { kind: "found" };
  }
}
