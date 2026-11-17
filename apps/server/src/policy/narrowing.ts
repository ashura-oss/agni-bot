/**
 * Capability narrowing (S2-06). A bot that starts work in another bot cannot
 * get more done through it than it could do itself.
 *
 *   child's effective tools = the child's own tools
 *                             ∩ the grant, when there is one
 *                             ∩ the parent's effective capabilities
 *
 * The parent's set travels with the work: in the child run's policy for a
 * handoff and in the job payload for a delegated task. A set that is missing
 * or cannot be read fails closed: the child gets only the inert tools (saying
 * something and asking the owner), never "everything its persona lists".
 */
import { policyFor } from "./metadata";

/** Most names a stored capability list may hold, and the longest name; a list outside these is unreadable. */
const MAX_CAPABILITIES = 1_000;
const MAX_NAME_CHARS = 100;

/** A tool that only talks to the owner (class `inert`): it does nothing a parent could not allow. */
export function isInertTool(name: string): boolean {
  return policyFor(name)?.classes.includes("inert") ?? false;
}

/**
 * What a child may call. `parent` undefined means the parent's capabilities are
 * unknown: only the inert tools survive. `grant` undefined means no grant.
 */
export function narrowCapabilities(
  own: Iterable<string>,
  parent: Iterable<string> | undefined,
  grant?: Iterable<string>,
): Set<string> {
  const parentSet = parent === undefined ? null : new Set(parent);
  const grantSet = grant === undefined ? null : new Set(grant);
  const kept = new Set<string>();
  for (const tool of own) {
    if (grantSet && !grantSet.has(tool)) continue;
    if (isInertTool(tool) || parentSet?.has(tool)) kept.add(tool);
  }
  return kept;
}

/**
 * Read a stored capability list (a job payload). Anything that is not a list of tool
 * names is unreadable and comes back undefined, which the caller treats as "unknown".
 * An empty list is readable: it says the parent could call nothing.
 */
export function readCapabilities(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_CAPABILITIES) return undefined;
  const names: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || item.length > MAX_NAME_CHARS) return undefined;
    names.push(item);
  }
  return names;
}
