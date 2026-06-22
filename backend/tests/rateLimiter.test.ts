import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';

/**
 * Rate-limiter tests.
 *
 * These run the REAL Lua check-and-increment against a REAL local Redis, because
 * the headline bug (the TOCTOU race between GET and INCR) only exists at the
 * Redis layer — ioredis-mock's Lua support is incomplete and would not exercise
 * the actual script. The MySQL dependency (getMailbox) is mocked out so the
 * tests need only Redis. If Redis is unreachable the whole suite is skipped
 * rather than failing red.
 */

// Mutable registry of fake mailboxes, shared with the hoisted db mock.
const { mailboxes } = vi.hoisted(() => ({
  mailboxes: new Map<number, { id: number; email: string; daily_limit: number; hourly_limit: number }>(),
}));

// Mock the DB pool so getMailbox() resolves from the in-memory registry.
vi.mock('../src/config/db', () => ({
  pool: {
    execute: async (_sql: string, params: unknown[]) => {
      const id = Number(params[0]);
      const mb = mailboxes.get(id);
      return [mb ? [mb] : [], undefined];
    },
  },
}));

import { redis } from '../src/config/redis';
import { checkAndIncrement, readQuota, remainingBudget } from '../src/mailboxes/rateLimiter';

let nextId = 990000;
const usedIds: number[] = [];

function newMailbox(daily: number, hourly: number): number {
  const id = nextId++;
  mailboxes.set(id, { id, email: `mb${id}@test.com`, daily_limit: daily, hourly_limit: hourly });
  usedIds.push(id);
  return id;
}

// Probe Redis at module load (top-level await) so `skipIf` — which is evaluated
// at collection time, before any hook runs — sees the real connectivity state.
// Bounded by a timeout so a missing Redis skips fast instead of hanging.
const redisUp = await (async () => {
  try {
    await Promise.race([
      redis.ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
    ]);
    return true;
  } catch {
    return false;
  }
})();

afterEach(async () => {
  if (!redisUp) return;
  // Clear every window key we touched so tests don't bleed into each other.
  for (const id of usedIds) {
    const keys = await redis.keys(`rl:*:${id}:*`);
    if (keys.length) await redis.del(...keys);
  }
});

afterAll(async () => {
  if (redisUp) await redis.quit();
});

describe.skipIf(!redisUp)('checkAndIncrement', () => {
  it('allows exactly up to the daily limit and rejects the next (boundary)', async () => {
    const id = newMailbox(5, 1000);
    const results = [];
    for (let i = 0; i < 7; i++) results.push(await checkAndIncrement(id));

    const allowed = results.filter((r) => r.allowed).length;
    expect(allowed).toBe(5); // not 6 — the original `>` let limit+1 through
    expect(results[5]).toEqual({ allowed: false, reason: 'daily' });
    expect(results[6]).toEqual({ allowed: false, reason: 'daily' });
  });

  it('enforces the hourly limit independently and reports the hourly reason', async () => {
    const id = newMailbox(1000, 3);
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await checkAndIncrement(id));

    expect(results.filter((r) => r.allowed).length).toBe(3);
    expect(results[3]).toEqual({ allowed: false, reason: 'hourly' });
  });

  it('reports daily before hourly when both would be exceeded', async () => {
    // daily is the tighter limit; the script checks daily first.
    const id = newMailbox(2, 2);
    await checkAndIncrement(id);
    await checkAndIncrement(id);
    const r = await checkAndIncrement(id);
    expect(r).toEqual({ allowed: false, reason: 'daily' });
  });

  it('returns not-allowed for an unknown mailbox', async () => {
    const r = await checkAndIncrement(424242);
    expect(r.allowed).toBe(false);
  });

  it('never exceeds the limit under concurrency (the TOCTOU race)', async () => {
    const LIMIT = 10;
    const FIRED = 100;
    const id = newMailbox(LIMIT, 1000);

    // Fire all increments concurrently. With the old GET-then-INCR sequence,
    // many callers would observe an under-limit count and all increment past
    // the limit. The atomic Lua script must let through exactly LIMIT.
    const results = await Promise.all(
      Array.from({ length: FIRED }, () => checkAndIncrement(id)),
    );

    const allowed = results.filter((r) => r.allowed).length;
    expect(allowed).toBe(LIMIT);

    // The Redis counter itself must not have overshot either.
    const snapshot = await readQuota(id);
    expect(snapshot!.daily.used).toBe(LIMIT);
  });

  it('sets a TTL on the window keys (no leaking non-expiring keys)', async () => {
    const id = newMailbox(5, 5);
    await checkAndIncrement(id);
    const dailyKeys = await redis.keys(`rl:daily:${id}:*`);
    const hourlyKeys = await redis.keys(`rl:hourly:${id}:*`);
    expect(dailyKeys.length).toBe(1);
    expect(hourlyKeys.length).toBe(1);
    expect(await redis.ttl(dailyKeys[0])).toBeGreaterThan(0);
    expect(await redis.ttl(hourlyKeys[0])).toBeGreaterThan(0);
  });
});

describe.skipIf(!redisUp)('readQuota / remainingBudget', () => {
  it('is a pure read: reports zero for a fresh mailbox without creating keys', async () => {
    const id = newMailbox(100, 10);
    const snap = await readQuota(id);
    expect(snap).toMatchObject({
      daily: { used: 0, limit: 100 },
      hourly: { used: 0, limit: 10 },
    });
    // The original wrote `SET key 0` (no TTL); the fix must not create keys.
    const keys = await redis.keys(`rl:*:${id}:*`);
    expect(keys.length).toBe(0);
  });

  it('reflects consumed sends and computes remaining budget', async () => {
    const id = newMailbox(100, 10);
    await checkAndIncrement(id);
    await checkAndIncrement(id);
    await checkAndIncrement(id);

    const snap = await readQuota(id);
    expect(snap!.daily.used).toBe(3);
    expect(snap!.hourly.used).toBe(3);

    const rem = await remainingBudget(id);
    expect(rem).toEqual({ daily: 97, hourly: 7 });
  });
});
