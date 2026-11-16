/**
 * A sliding-window attempt limiter, kept in memory.
 *
 * Used for pairing (`POST /auth/pair`): 5 attempts a minute per address, plus a
 * ceiling across all addresses so a caller that rotates its address cannot
 * wear down the code space. State lives in memory on purpose: it only has
 * to outlast a burst, an attacker cannot restart the daemon, and an
 * unauthenticated route should not write to the database at all.
 */

export interface AttemptResult {
  ok: boolean;
  /** When refused: how long until an attempt would be allowed. */
  retryAfterMs: number;
}

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {}

  /** Number of addresses currently tracked (bounded by `maxKeys`). */
  get size(): number {
    return this.hits.size;
  }

  /** Record an attempt for `key` and say whether it is allowed. A refused attempt is not recorded, so it does not extend the lockout. */
  attempt(key: string): AttemptResult {
    const now = this.now();
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((at) => at > cutoff);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return { ok: false, retryAfterMs: Math.max(1, (recent[0] ?? now) + this.windowMs - now) };
    }
    recent.push(now);
    if (!this.hits.has(key) && this.hits.size >= this.maxKeys) this.makeRoom(cutoff);
    this.hits.set(key, recent);
    return { ok: true, retryAfterMs: 0 };
  }

  /** Drop expired keys; if the table is still full, drop the oldest-seen key. */
  private makeRoom(cutoff: number): void {
    for (const [key, times] of this.hits) {
      if ((times[times.length - 1] ?? 0) <= cutoff) this.hits.delete(key);
    }
    while (this.hits.size >= this.maxKeys) {
      const oldest = this.hits.keys().next().value;
      if (oldest === undefined) break;
      this.hits.delete(oldest);
    }
  }
}

/** Pairing attempts: per address, then across every address. */
export interface PairLimiter {
  attempt(address: string): AttemptResult;
}

export const PAIR_ATTEMPTS_PER_MINUTE = 5;
/** Across all addresses: far above one owner pairing a few devices, far below a guessing run. */
export const PAIR_ATTEMPTS_PER_MINUTE_TOTAL = 20;

export function createPairLimiter(now: () => number = Date.now): PairLimiter {
  const perAddress = new RateLimiter(PAIR_ATTEMPTS_PER_MINUTE, 60_000, now);
  const total = new RateLimiter(PAIR_ATTEMPTS_PER_MINUTE_TOTAL, 60_000, now, 1);
  return {
    attempt(address) {
      const mine = perAddress.attempt(address);
      if (!mine.ok) return mine;
      return total.attempt("*");
    },
  };
}

const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * The address to count a request against. The socket peer is the truth, and
 * it is the answer unless the owner has said a proxy on this machine sits in
 * front (`AGNI_TRUST_PROXY=1`, as with `tailscale serve`, where every peer is
 * loopback). Only then is `X-Forwarded-For` read: its last entry, which the
 * proxy appended and the client cannot forge, and only from a loopback peer.
 * Without the flag the header is ignored, so a caller cannot pick its own
 * address by sending one.
 */
export function clientAddress(peer: string | undefined, forwardedFor: string | null, trustProxy = false): string {
  const address = peer ?? "unknown";
  if (!trustProxy || !LOOPBACK_PEERS.has(address) || !forwardedFor) return address;
  const last = forwardedFor.split(",").pop()?.trim();
  return last ? last.slice(0, 64) : address;
}
