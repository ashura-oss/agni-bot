/**
 * Every real-model eval task, in run order. Sources: round 5 (in-app),
 * round 4 shapes moved into the app, and real failures from round 2,
 * round 5 and `project-log/ISSUES.md`.
 */
import type { TaskDef } from "../types";
import { ROUND5_TASKS } from "./round5";

export const TASKS: TaskDef[] = [...ROUND5_TASKS];

export function findTasks(ids: string[] | "all"): TaskDef[] {
  if (ids === "all") return TASKS;
  return ids.map((id) => {
    const task = TASKS.find((t) => t.id === id);
    if (!task) throw new Error(`no eval task "${id}". Known: ${TASKS.map((t) => t.id).join(", ")}`);
    return task;
  });
}
