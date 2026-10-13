/** Sliding-window limiter: at most `limit` hits in any `windowMs`. */
export class RateLimiter {
  private hits: number[] = [];

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a hit and returns 0, or returns how many ms to wait without recording. */
  take(): number {
    const t = this.now();
    this.hits = this.hits.filter((h) => t - h < this.windowMs);
    if (this.hits.length >= this.limit) return this.windowMs - (t - this.hits[0]!);
    this.hits.push(t);
    return 0;
  }
}
