import { describe, it, expect } from 'vitest';
import { nextAvailableSlot, type MailboxBudget } from '../src/sequences/scheduler';

/**
 * Pure unit tests for the per-mailbox budget allocator shared by schedule and
 * resume. No DB/Redis: we hand-build a MailboxBudget and assert the slot logic
 * (overflow rolling to the next window, remaining-vs-full-limit, zero limits).
 */

const NOW = new Date('2026-01-01T00:00:00.000Z');

// Mirror the (unexported) key helpers in scheduler.ts exactly.
const dayKey = (d: Date) => `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
const hourKey = (d: Date) => `${dayKey(d)}T${d.getUTCHours()}`;
const TODAY = dayKey(NOW);
const THIS_HOUR = hourKey(NOW);

function budget(overrides: Partial<MailboxBudget> = {}): MailboxBudget {
  return {
    dailyLimit: 1000,
    hourlyLimit: 1000,
    dailyRemainingNow: 1000,
    hourlyRemainingNow: 1000,
    dayCounts: new Map(),
    hourCounts: new Map(),
    ...overrides,
  };
}

function assign(b: MailboxBudget, desired: Date) {
  return nextAvailableSlot(b, desired, NOW, TODAY, THIS_HOUR);
}

describe('nextAvailableSlot', () => {
  it('places sends in the current window while capacity remains', () => {
    const b = budget({ hourlyLimit: 3, hourlyRemainingNow: 3 });
    expect(assign(b, NOW)?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(assign(b, NOW)?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('rolls overflow to the next hour when the hourly limit is hit', () => {
    const b = budget({ hourlyLimit: 2, hourlyRemainingNow: 2 });
    assign(b, NOW);
    assign(b, NOW);
    // third send this hour overflows to the next hour
    expect(assign(b, NOW)?.toISOString()).toBe('2026-01-01T01:00:00.000Z');
  });

  it('rolls overflow to the next day when the daily limit is hit', () => {
    const b = budget({ dailyLimit: 2, dailyRemainingNow: 2, hourlyLimit: 100, hourlyRemainingNow: 100 });
    assign(b, NOW);
    assign(b, NOW);
    expect(assign(b, NOW)?.toISOString()).toBe('2026-01-02T00:00:00.000Z');
  });

  it('uses remaining budget for the current window but full limit for future windows', () => {
    // Only 1 left today, but the daily limit is 100. Second send must roll to
    // tomorrow; a third still fits tomorrow because the future window is full.
    const b = budget({ dailyLimit: 100, dailyRemainingNow: 1, hourlyLimit: 100, hourlyRemainingNow: 100 });
    expect(assign(b, NOW)?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(assign(b, NOW)?.toISOString()).toBe('2026-01-02T00:00:00.000Z');
    expect(assign(b, NOW)?.toISOString()).toBe('2026-01-02T00:00:00.000Z');
  });

  it('floors a desired time in the past up to now', () => {
    const b = budget();
    const past = new Date(NOW.getTime() - 3600_000);
    expect(assign(b, past)?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('honours a future desired time', () => {
    const b = budget();
    const future = new Date('2026-01-03T05:00:00.000Z');
    expect(assign(b, future)?.toISOString()).toBe('2026-01-03T05:00:00.000Z');
  });

  it('returns null for a mailbox that can never send (zero limit)', () => {
    expect(assign(budget({ dailyLimit: 0 }), NOW)).toBeNull();
    expect(assign(budget({ hourlyLimit: 0 }), NOW)).toBeNull();
  });
});
