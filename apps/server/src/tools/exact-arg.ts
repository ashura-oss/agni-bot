/**
 * An argument the policy gate judges, used exactly as the gate saw it (C1, Sprint 5 hotfix).
 *
 * The gate decides a call from its arguments as written. A handler that tidies a judged value before acting on it (trims a
 * path, say) acts on something the gate never judged: " ../x" was judged a new file inside scratch and written to ../x.
 * So a judged value is never changed: one that starts or ends with whitespace is refused, and the model is told why.
 */
export function exactString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} must be a non-empty string`);
  if (value !== value.trim()) throw new Error(`${name} must not start or end with spaces or line breaks`);
  return value;
}
