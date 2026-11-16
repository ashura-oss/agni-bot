/**
 * Which turns this browser saw end badly. History rows do not say how their
 * turn ended, so without this a "Response didn't finish" mark vanishes on
 * reload. It is a small local memory, not a record: the daemon is the source
 * of truth, and an entry only re-draws a marker.
 */
const KEY = "dev.agni.stops";
const LIMIT = 300;

export function loadStops(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [turnID, reason] of Object.entries(parsed)) if (typeof reason === "string") out[turnID] = reason;
    return out;
  } catch {
    return {};
  }
}

export function rememberStop(turnID: string, reason: string): void {
  try {
    const stops = loadStops();
    delete stops[turnID];
    stops[turnID] = reason;
    const keys = Object.keys(stops);
    for (const key of keys.slice(0, Math.max(0, keys.length - LIMIT))) delete stops[key];
    localStorage.setItem(KEY, JSON.stringify(stops));
  } catch {
    // Storage blocked or full: the marker is a nicety, not a record.
  }
}
