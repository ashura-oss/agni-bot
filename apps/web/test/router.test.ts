import { describe, expect, it } from "vitest";
import { agentForRoute, agentPath, parseRoute, resolveRoute, routePath, type Route } from "../src/state/router";

const roster = [
  { id: "ea", name: "Friday", tools: [] },
  { id: "new_bot", name: "New bot", tools: [] },
];

describe("parseRoute", () => {
  it("reads every main screen's address", () => {
    expect(parseRoute("/")).toEqual({ kind: "root" });
    expect(parseRoute("/agent/ea")).toEqual({ kind: "agent", id: "ea" });
    expect(parseRoute("/group/grp_1")).toEqual({ kind: "group", id: "grp_1" });
    expect(parseRoute("/task/tsk_9")).toEqual({ kind: "task", id: "tsk_9" });
    expect(parseRoute("/settings")).toEqual({ kind: "settings", section: null });
    expect(parseRoute("/settings/models")).toEqual({ kind: "settings", section: "models" });
  });

  it("keeps the task list views that already had addresses", () => {
    expect(parseRoute("/tasks")).toEqual({ kind: "tasks", view: { kind: "today" } });
    expect(parseRoute("/tasks/inbox")).toEqual({ kind: "tasks", view: { kind: "inbox" } });
    expect(parseRoute("/tasks/collection/lst_a")).toEqual({ kind: "tasks", view: { kind: "list", listID: "lst_a" } });
  });

  it("decodes ids and ignores a trailing slash", () => {
    expect(parseRoute("/agent/new%20bot/")).toEqual({ kind: "agent", id: "new bot" });
    expect(parseRoute("/task/a%2Fb")).toEqual({ kind: "task", id: "a/b" });
  });

  it("keeps the address of a page that does not exist", () => {
    expect(parseRoute("/nope")).toEqual({ kind: "not-found", path: "/nope" });
    expect(parseRoute("/agent")).toEqual({ kind: "not-found", path: "/agent" });
    expect(parseRoute("/agent/ea/extra")).toEqual({ kind: "not-found", path: "/agent/ea/extra" });
    expect(parseRoute("/settings/bogus")).toEqual({ kind: "not-found", path: "/settings/bogus" });
    expect(parseRoute("/agent/%E0%A4%A")).toEqual({ kind: "not-found", path: "/agent/%E0%A4%A" });
  });

  it("does not show Today for a task view that does not exist", () => {
    expect(parseRoute("/tasks/bogus")).toEqual({ kind: "not-found", path: "/tasks/bogus" });
    expect(parseRoute("/tasks/collection")).toEqual({ kind: "not-found", path: "/tasks/collection" });
    expect(parseRoute("/tasks/inbox/extra")).toEqual({ kind: "not-found", path: "/tasks/inbox/extra" });
    expect(parseRoute("/tasks/collection/lst_a/extra")).toEqual({ kind: "not-found", path: "/tasks/collection/lst_a/extra" });
  });

  it("still reads /tasks/today as Today", () => {
    expect(parseRoute("/tasks/today")).toEqual({ kind: "tasks", view: { kind: "today" } });
  });
});

describe("routePath", () => {
  it("gives back the address parseRoute read", () => {
    const routes: Route[] = [
      { kind: "agent", id: "new bot" },
      { kind: "group", id: "grp_1" },
      { kind: "task", id: "a/b" },
      { kind: "settings", section: null },
      { kind: "settings", section: "appearance" },
      { kind: "tasks", view: { kind: "today" } },
      { kind: "tasks", view: { kind: "calendar" } },
      { kind: "tasks", view: { kind: "list", listID: "lst_a" } },
    ];
    for (const route of routes) expect(parseRoute(routePath(route))).toEqual(route);
  });

  it("writes a bot's address from its id", () => {
    expect(agentPath(roster[1]! as never)).toBe("/agent/new_bot");
    expect(agentPath(null)).toBe("/agent/ea");
  });
});

describe("resolveRoute", () => {
  const known = { rosterKnown: true, agents: roster as never, groups: [{ id: "grp_1" }] as never, tasks: [{ id: "tsk_1" }] as never, tasksKnown: true };

  it("finds bots by id, and old name links when one bot has the name", () => {
    expect(resolveRoute({ kind: "agent", id: "new_bot" }, known)).toEqual({ kind: "found" });
    expect(resolveRoute({ kind: "agent", id: "new-bot" }, known)).toEqual({ kind: "found" });
    expect(agentForRoute("friday", roster as never)?.id).toBe("ea");
  });

  it("says not-found only once the thing could have been known", () => {
    expect(resolveRoute({ kind: "agent", id: "ghost" }, known)).toEqual({ kind: "missing", what: "bot", path: "/agent/ghost" });
    expect(resolveRoute({ kind: "agent", id: "ghost" }, { ...known, rosterKnown: false })).toEqual({ kind: "pending" });
    expect(resolveRoute({ kind: "group", id: "ghost" }, known)).toEqual({ kind: "missing", what: "group", path: "/group/ghost" });
    expect(resolveRoute({ kind: "group", id: "grp_1" }, known)).toEqual({ kind: "found" });
    expect(resolveRoute({ kind: "group", id: "grp_1" }, { ...known, groups: null })).toEqual({ kind: "pending" });
    expect(resolveRoute({ kind: "task", id: "ghost" }, known)).toEqual({ kind: "missing", what: "task", path: "/task/ghost" });
    expect(resolveRoute({ kind: "task", id: "tsk_1" }, known)).toEqual({ kind: "found" });
    expect(resolveRoute({ kind: "task", id: "tsk_1" }, { ...known, tasksKnown: false, tasks: [] })).toEqual({ kind: "pending" });
  });

  it("reports an unknown page as missing, with the address it had", () => {
    expect(resolveRoute({ kind: "not-found", path: "/nope" }, known)).toEqual({ kind: "missing", what: "page", path: "/nope" });
  });
});
