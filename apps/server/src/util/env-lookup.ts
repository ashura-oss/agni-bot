export type Env = Record<string, string | undefined>;

/**
 * The value of an environment variable by name. Windows names ignore case
 * (`Path`, `PATH`, `SystemRoot`, `SYSTEMROOT`), so an exact match wins and
 * any other casing is the fallback. An empty value counts as unset.
 */
export function envValue(env: Env, name: string): string | undefined {
  const exact = env[name];
  if (exact) return exact;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (value && key.toLowerCase() === lower) return value;
  }
  return undefined;
}

/** An absolute Windows drive path (`C:\...` or `C:/...`). A relative path, a bare drive, or a UNC path is not one. */
export function isWindowsDrivePath(path: string | undefined): path is string {
  return !!path && /^[A-Za-z]:[\\/]/.test(path);
}
