/**
 * The turn's clock. One deadline covers the work of the whole turn, but the
 * time the owner spends deciding (an approval card, a question) is not the
 * model's time, so the clock stops while any call is waiting on them.
 */
export class TurnTimer {
  private remainingMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private startedAt = 0;
  private holds = 0;
  private done = false;

  private started = false;

  constructor(totalMs: number, private readonly onExpire: () => void) {
    this.remainingMs = totalMs;
  }

  /** Start the clock. Until then no time passes, and a hold has nothing to stop. */
  start(): void {
    if (this.started || this.done) return;
    this.started = true;
    if (this.holds === 0) this.run();
  }

  /**
   * Stop the clock until the returned function is called. Waits may overlap:
   * the clock restarts only when the last one is released.
   */
  hold(): () => void {
    if (this.done) return () => undefined;
    if (this.holds === 0 && this.started) {
      this.stop();
      this.remainingMs = Math.max(0, this.remainingMs - (Date.now() - this.startedAt));
    }
    this.holds += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds -= 1;
      if (this.holds === 0 && this.started && !this.done) this.run();
    };
  }

  /** The turn is over; the clock never fires again. */
  clear(): void {
    this.done = true;
    this.stop();
  }

  private run(): void {
    this.startedAt = Date.now();
    this.timer = setTimeout(() => { this.timer = null; this.onExpire(); }, this.remainingMs);
  }

  private stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
