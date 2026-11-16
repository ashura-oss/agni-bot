/**
 * Secret redaction for streamed text (S3-03 review).
 *
 * `redact` works on one string. A model streams its answer in small pieces,
 * so a secret can be split across `token` frames and never appear whole in
 * any one of them. `StreamRedactor` keeps, per stream, the last few
 * characters that could still turn into a registered secret, and sends them
 * with the next piece, or at the end of the stream.
 *
 * Only a tail that is the start of a registered value is held (see
 * `holdbackLength`): ordinary text goes out at once, and with no secret
 * registered nothing is held at all. The most that can ever wait is one
 * character less than the longest registered variant.
 */
import { holdbackLength, redact } from "./redact";

/** More concurrent streams than this means turns that never ended; the oldest is dropped. */
const MAX_STREAMS = 256;

export class StreamRedactor {
  private readonly pending = new Map<string, string>();

  /** Add `delta` to stream `key`; returns the text that is safe to send now. */
  push(key: string, delta: string): string {
    const text = redact((this.pending.get(key) ?? "") + delta);
    let hold = holdbackLength(text);
    // Never cut between the halves of a surrogate pair.
    const cut = text.length - hold;
    if (hold > 0 && cut > 0 && isLowSurrogate(text.charCodeAt(cut)) && isHighSurrogate(text.charCodeAt(cut - 1))) hold++;
    if (hold === 0) {
      this.pending.delete(key);
      return text;
    }
    this.pending.delete(key);
    if (this.pending.size >= MAX_STREAMS) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) this.pending.delete(oldest);
    }
    this.pending.set(key, text.slice(text.length - hold));
    return text.slice(0, text.length - hold);
  }

  /** The stream ended: return what was held. */
  flush(key: string): string {
    const rest = this.pending.get(key);
    this.pending.delete(key);
    return rest ? redact(rest) : "";
  }

  /** The stream's text was discarded by the client (a reset): forget what was held. */
  drop(key: string): void {
    this.pending.delete(key);
  }

  clear(): void {
    this.pending.clear();
  }
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;
