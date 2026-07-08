export interface RateLimiter {
  allow(key: string): boolean;
}

/* Fixed-window per-key limiter. Cheap insurance if a shared token leaks. The
   clock is injectable so tests are deterministic. perMin<=0 disables limiting. */
export function createRateLimiter(perMin: number, now: () => number = () => Date.now()): RateLimiter {
  if (perMin <= 0) {
    return { allow: () => true };
  }
  const windowMs = 60_000;
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return {
    allow(key: string): boolean {
      const t = now();
      const bucket = buckets.get(key);
      if (!bucket || t >= bucket.resetAt) {
        buckets.set(key, { count: 1, resetAt: t + windowMs });
        return true;
      }
      if (bucket.count >= perMin) {
        return false;
      }
      bucket.count++;
      return true;
    }
  };
}
