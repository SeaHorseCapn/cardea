export class RateLimiter {
  private buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly limit = 60, private readonly windowMs = 60_000) {}

  allow(key: string, now = Date.now()): boolean {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (bucket.count >= this.limit) return false;
    bucket.count += 1;
    return true;
  }
}
