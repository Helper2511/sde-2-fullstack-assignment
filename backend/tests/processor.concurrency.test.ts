import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Job } from 'bullmq';

/**
 * Concurrency test for the worker's atomic row claim.
 *
 * Resume and the rate-limit retry path can both leave a queue job pointing at
 * the same scheduled_email, so two workers may pick up the same row at once.
 * The fix is a conditional UPDATE (`SET status='processing' WHERE id=? AND
 * status='pending'`) that lets exactly one caller win; the loser sees
 * affectedRows===0 and bails before consuming quota or sending.
 *
 * MySQL isn't available in this environment, so the DB is modeled by a tiny
 * in-memory store whose conditional UPDATE performs its read-modify-write
 * synchronously within a single execute() call — which is exactly the atomic
 * compare-and-set guarantee MySQL gives for that statement. The test asserts the
 * processor *honours* the claim result: send() and the quota consume each happen
 * exactly once even when two jobs race the same row.
 */

interface Row {
  id: number;
  sequence_id: number;
  step_id: number;
  prospect_id: number;
  mailbox_id: number;
  status: string;
  attempts: number;
  prospect_status: string;
  sequence_status: string;
}

const h = vi.hoisted(() => ({
  row: null as Row | null,
  sendCount: 0,
  checkCount: 0,
  checkResult: { allowed: true } as { allowed: boolean; reason?: string },
  logs: [] as Array<{ status: string; message: string }>,
}));

vi.mock('../src/config/db', () => ({
  pool: {
    // The whole body is synchronous up to `return`, so each execute() is an
    // atomic step relative to other concurrent execute() calls — modeling the
    // DB's per-statement atomicity for the conditional claim.
    execute: async (sql: string, params: unknown[]) => {
      const row = h.row;
      if (!row) return [[], undefined];

      if (sql.includes('FROM scheduled_emails se') && sql.includes('JOIN')) {
        if (Number(params[0]) !== row.id) return [[], undefined];
        return [
          [
            {
              id: row.id,
              sequence_id: row.sequence_id,
              step_id: row.step_id,
              prospect_id: row.prospect_id,
              mailbox_id: row.mailbox_id,
              status: row.status,
              attempts: row.attempts,
              subject: 'Subject',
              body: 'Body',
              prospect_email: 'p@test.com',
              prospect_status: row.prospect_status,
              mailbox_email: 'm@test.com',
              sequence_status: row.sequence_status,
            },
          ],
          undefined,
        ];
      }
      if (sql.includes("SET status='processing'")) {
        // Atomic compare-and-set: only the first caller flips pending->processing.
        if (row.status === 'pending') {
          row.status = 'processing';
          return [{ affectedRows: 1 }, undefined];
        }
        return [{ affectedRows: 0 }, undefined];
      }
      if (sql.includes('attempts = attempts + 1')) {
        row.attempts += 1;
        return [{ affectedRows: 1 }, undefined];
      }
      if (sql.includes("SET status='sent'")) {
        row.status = 'sent';
        return [{ affectedRows: 1 }, undefined];
      }
      if (sql.includes("SET status='failed'")) {
        row.status = 'failed';
        return [{ affectedRows: 1 }, undefined];
      }
      if (sql.includes("SET status='pending'")) {
        row.status = 'pending';
        return [{ affectedRows: 1 }, undefined];
      }
      if (sql.includes("status='skipped'")) {
        row.status = 'skipped';
        return [{ affectedRows: 1 }, undefined];
      }
      if (sql.includes('INSERT INTO send_logs')) {
        h.logs.push({ status: String(params[2]), message: String(params[3]) });
        return [{ insertId: 1 }, undefined];
      }
      return [[], undefined];
    },
  },
}));

vi.mock('../src/mailboxes/rateLimiter', () => ({
  checkAndIncrement: async () => {
    h.checkCount += 1;
    return h.checkResult;
  },
}));

vi.mock('../src/sequences/scheduler', () => ({
  sendQueue: { add: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) },
  SEND_QUEUE: 'email-send',
}));

vi.mock('../src/worker/smtpAdapter', () => ({
  send: async () => {
    h.sendCount += 1;
  },
}));

import { processSendJob } from '../src/worker/processor';
import { sendQueue } from '../src/sequences/scheduler';

function job(): Job<{ scheduledEmailId: number; sequenceId: number }> {
  return { data: { scheduledEmailId: 1, sequenceId: 1 } } as Job<{
    scheduledEmailId: number;
    sequenceId: number;
  }>;
}

function baseRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 1,
    sequence_id: 1,
    step_id: 1,
    prospect_id: 1,
    mailbox_id: 1,
    status: 'pending',
    attempts: 0,
    prospect_status: 'active',
    sequence_status: 'active',
    ...overrides,
  };
}

beforeEach(() => {
  h.row = baseRow();
  h.sendCount = 0;
  h.checkCount = 0;
  h.checkResult = { allowed: true };
  h.logs = [];
  vi.clearAllMocks();
});

describe('processSendJob atomic claim', () => {
  it('sends exactly once when two jobs race the same pending row', async () => {
    await Promise.all([processSendJob(job()), processSendJob(job())]);

    expect(h.sendCount).toBe(1); // the loser must not send
    expect(h.checkCount).toBe(1); // quota consumed once, not twice
    expect(h.row!.status).toBe('sent');
    expect(h.row!.attempts).toBe(1);
  });

  it('is a no-op for a row that is already past pending', async () => {
    h.row = baseRow({ status: 'sent' });
    await processSendJob(job());
    expect(h.sendCount).toBe(0);
    expect(h.checkCount).toBe(0);
  });
});

describe('processSendJob pause guard', () => {
  it('does not send and leaves the row pending when the sequence is paused', async () => {
    h.row = baseRow({ sequence_status: 'paused' });
    await processSendJob(job());

    expect(h.sendCount).toBe(0);
    expect(h.checkCount).toBe(0);
    expect(h.row!.status).toBe('pending'); // resume must be able to reschedule it
    expect(h.logs.some((l) => l.status === 'paused')).toBe(true);
  });

  it('skips an unsubscribed prospect without sending', async () => {
    h.row = baseRow({ prospect_status: 'unsubscribed' });
    await processSendJob(job());

    expect(h.sendCount).toBe(0);
    expect(h.row!.status).toBe('skipped');
  });
});

describe('processSendJob rate-limit handling', () => {
  it('releases the claim and re-enqueues when rate limited', async () => {
    h.checkResult = { allowed: false, reason: 'hourly' };
    await processSendJob(job());

    expect(h.sendCount).toBe(0);
    expect(h.row!.status).toBe('pending'); // claim released
    expect(h.row!.attempts).toBe(0); // a bounce is not a delivery attempt
    expect(sendQueue.add).toHaveBeenCalledTimes(1); // re-enqueued
    expect(h.logs.some((l) => l.status === 'rate_limited')).toBe(true);
  });
});
