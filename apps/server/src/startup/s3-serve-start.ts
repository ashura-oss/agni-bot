/**
 * How `serve` takes the serve lock at start. Everything the lock module does, plus one thing only `serve` may do: call a
 * lock stale although its pid is alive.
 *
 * A hard kill (Windows `daemon stop`, a crash, a power cut) leaves `serve.lock` behind, and once the machine reuses that
 * pid for an unrelated process the lock looks held for good. The lock records where its server listens (`recordEndpoint`,
 * written once the server is listening). If nothing accepts a connection there for a few seconds, no server is serving
 * from this home, whatever the pid says, and `serve` takes the lock over. Anything else keeps the lock held: a server that
 * answers `/health`, one that accepts the connection and never answers (wedged: it still owns the port), a lock that
 * records no address (a server still starting, or one that has not got that far), an address that cannot be probed with
 * certainty (a wildcard or a host name: only an IP literal, or `localhost` refusing on both loopbacks, counts), and any
 * process that is not `serve`.
 * `vault migrate` and `export` never reach this file: with the state unknown they stay fail closed.
 */
import { connect, isIP } from "node:net";
import { ServeLockError, acquireServeLock, removeServeLockIfUnchanged, serveLockPath, type ServeLock, type ServeLockOptions } from "./s3-serve-lock";

export interface ServeStartOptions extends ServeLockOptions {
  /** How long the recorded address must keep refusing connections before the lock is called stale. */
  silentForMs?: number;
  /** Time between probes. */
  pollMs?: number;
}

/**
 * Every address that must refuse for a server recorded at `host` to be called gone, or none when that cannot be known
 * (fail closed: the lock stays held and the refusal tells the person which file to delete).
 *   - an IP literal: that address;
 *   - `localhost`: both loopbacks. Which one `Bun.serve({ hostname: "localhost" })` binds depends on the machine (Windows
 *     with Bun 1.4.3 listens on `::1` only), so a refusal on `127.0.0.1` alone proves nothing;
 *   - a wildcard (`0.0.0.0`, `::`), another name, or no host at all: the addresses it stands for are not known here.
 */
function probeTargets(host: string | undefined): string[] {
  if (!host) return [];
  if (host.toLowerCase() === "localhost") return ["127.0.0.1", "::1"];
  const literal = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (isIP(literal) === 0 || literal === "0.0.0.0" || literal === "::") return [];
  return [literal];
}

/**
 * True when nothing is listening at host:port. Only an explicit refusal counts: a connection that is accepted, or that
 * fails any other way (a timeout, an unreachable network), may be a server and is reported as "something may be there".
 */
function refusesConnections(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (refused: boolean): void => {
      socket.destroy();
      resolve(refused);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(false));
    socket.once("error", (error: NodeJS.ErrnoException) => done(error.code === "ECONNREFUSED"));
  });
}

/** True when every address refuses every probe from now until `silentForMs` has passed. */
async function silentFor(hosts: string[], port: number, silentForMs: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + silentForMs;
  for (;;) {
    const refused = await Promise.all(hosts.map((host) => refusesConnections(host, port, Math.max(pollMs, 1_000))));
    if (!refused.every(Boolean)) return false;
    if (Date.now() >= deadline) return true;
    await Bun.sleep(pollMs);
  }
}

/** The serve lock, taken the way `serve` takes it (see the file comment). Throws `ServeLockError` when it cannot be. */
export async function acquireServeLockAtStart(options: ServeStartOptions = {}): Promise<ServeLock> {
  try {
    return acquireServeLock(options);
  } catch (error) {
    const holder = error instanceof ServeLockError ? error.holder : undefined;
    if (!holder || holder.port === undefined) throw error;
    const targets = probeTargets(holder.host);
    if (targets.length === 0) throw error;
    if (!(await silentFor(targets, holder.port, options.silentForMs ?? 3_000, options.pollMs ?? 500))) throw error;
    // Nothing is serving there. Remove the lock only if it is still the one that was judged (a server that took it over
    // in the meantime is not ours to remove), then take it the ordinary way.
    removeServeLockIfUnchanged(serveLockPath(options.home), holder.raw);
    return acquireServeLock(options);
  }
}
