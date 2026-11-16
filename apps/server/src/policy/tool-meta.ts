/**
 * What a tool is, for the approval policy. Frozen shared type: change it only
 * through the tech lead.
 *
 *  - untrusted-reader: returns text an outsider can write (web pages, mail).
 *  - private-reader: returns the owner's private data (files, memory, vault).
 *  - effector: changes something outside the app (writes, sends, runs).
 *  - inert: neither reads nor changes anything that matters.
 */
export type ToolClass = "untrusted-reader" | "private-reader" | "effector" | "inert";

/** 0 is the least dangerous, 3 the most. */
export type ToolTier = 0 | 1 | 2 | 3;

export interface ToolResource {
  kind: "path" | "recipient" | "host" | "url" | "channel" | "amount" | "other";
  value: string;
}

export interface ToolMeta {
  classes: ToolClass[];
  tier: ToolTier;
  /** The things a call touches, read from its arguments, for rules and the audit trail. */
  resources?: (args: Record<string, unknown>) => ToolResource[];
}
