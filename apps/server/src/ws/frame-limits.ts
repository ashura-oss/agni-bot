/**
 * Limits on what one socket connection may send (S3-05).
 *
 * `MAX_FRAME_BYTES` is handed to the server as `maxPayloadLength`: a larger
 * frame is refused by the socket layer itself (close code 1009) before any of
 * it is decoded. The owner's longest message is 100,000 characters, which is up
 * to 400 KB of UTF-8 and about 600 KB once JSON escapes it; attachments travel
 * over HTTP, not through the socket. 1 MiB clears that with room.
 *
 * `FrameBucket` is a token bucket per connection: a burst the size of a
 * reconnect (hello, resync and a dozen list requests) is fine; a sustained
 * stream above `FRAME_REFILL_PER_SECOND` is not, and the connection is closed
 * with `RATE_LIMIT_CLOSE_CODE`. The client reconnects by itself.
 */

export const MAX_FRAME_BYTES = 1024 * 1024;
export const FRAME_BURST = 100;
export const FRAME_REFILL_PER_SECOND = 20;
/** Application close code, after HTTP 429. */
export const RATE_LIMIT_CLOSE_CODE = 4029;
export const RATE_LIMIT_CLOSE_REASON = "rate limited";

export class FrameBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity = FRAME_BURST,
    private readonly refillPerSecond = FRAME_REFILL_PER_SECOND,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  /** Spend one frame's worth. False when the connection is over its rate. */
  take(): boolean {
    const now = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refillPerSecond);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
