import { pool } from '../config/db';
import { Queue, type Job } from 'bullmq';
import { bullConnection } from '../config/redis';
import {
  getSteps,
  getProspects,
  setSequenceStatus,
  computeNextSendTime,
} from './service';
import { getMailbox, remainingBudget } from '../mailboxes/rateLimiter';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';

export const SEND_QUEUE = 'email-send';
export const sendQueue = new Queue(SEND_QUEUE, { connection: bullConnection });

/** Payload carried by every send job. `sequenceId` lets us cancel a sequence's
 *  delayed jobs without a per-job DB lookup (see cancelDelayedJobs). */
export interface SendJobData {
  scheduledEmailId: number;
  sequenceId: number;
}

interface ScheduleOpts {
  sequenceId: number;
  /** When to start scheduling from. Defaults to now. */
  from?: Date;
}

interface ScheduleResult {
  scheduled: number;
  skipped: number;
}

/** (Re)enqueue a send under its deterministic `se-<id>` jobId. Callers remove any
 *  stale job with that id first when re-scheduling. */
async function enqueueSend(data: SendJobData, fireAt: Date): Promise<void> {
  const delay = Math.max(0, fireAt.getTime() - Date.now());
  await sendQueue.add('send', data, { delay, jobId: `se-${data.scheduledEmailId}` });
}

/**
 * Schedule a sequence: for each (prospect, step) pair, create a
 * `scheduled_emails` row and enqueue a delayed BullMQ job. Send-times respect
 * each mailbox's daily/hourly budget (overflow rolls to the next window) so the
 * initial schedule doesn't dump 500 jobs onto a 100/day mailbox and rely on the
 * rate limiter bouncing them — the same budget logic resume uses.
 */
export async function scheduleSequence(opts: ScheduleOpts): Promise<ScheduleResult> {
  const { sequenceId, from = new Date() } = opts;

  const steps = await getSteps(sequenceId);
  const prospects = await getProspects(sequenceId);
  const mailboxId = await pickMailboxForSequence(sequenceId);

  // Idempotency: any prospect that already has scheduled_emails for this
  // sequence is skipped, so calling /schedule twice (double-click, or adding
  // new prospects to a live sequence) doesn't duplicate every existing row.
  const [existingRows] = await pool.execute<RowDataPacket[]>(
    'SELECT DISTINCT prospect_id FROM scheduled_emails WHERE sequence_id = ?',
    [sequenceId],
  );
  const alreadyScheduled = new Set(existingRows.map((r) => r.prospect_id as number));

  // Flip draft -> active BEFORE enqueuing. A step with delay_days = 0 produces a
  // zero-delay job that the worker can pick up immediately; if the sequence were
  // still 'draft' at that moment the worker's pause guard would hold the send and
  // leave the row pending with no job to retry it (stuck forever). Activating
  // first closes that window. Only a draft is promoted — never a paused sequence
  // (that would bypass the resume flow and silently un-pause it).
  const [seqRows] = await pool.execute<RowDataPacket[]>(
    'SELECT status FROM sequences WHERE id = ? LIMIT 1',
    [sequenceId],
  );
  if (seqRows[0]?.status === 'draft') {
    await setSequenceStatus(sequenceId, 'active');
  }

  const tracker = createBudgetTracker(new Date());
  let scheduled = 0;
  let skipped = 0;

  for (const prospect of prospects) {
    if (prospect.status !== 'active' || alreadyScheduled.has(prospect.id)) {
      skipped++;
      continue;
    }

    // Walk every step for this prospect. Delays cascade: each step's *desired*
    // time is `delay_days` after the previous step's desired time (not measured
    // from `from`), then the budget tracker may push the actual slot later.
    let desired = from;
    for (let i = 0; i < steps.length; i++) {
      try {
        const step = steps[i];
        desired = computeNextSendTime(desired, step.delay_days);

        const slot = await tracker.assign(mailboxId, desired);
        if (!slot) {
          // Mailbox has no usable budget (limit 0 or pathological backlog).
          skipped++;
          continue;
        }

        const [result] = await pool.execute<ResultSetHeader>(
          `INSERT INTO scheduled_emails
             (sequence_id, step_id, prospect_id, mailbox_id, scheduled_at, status, attempts)
           VALUES (?, ?, ?, ?, ?, 'pending', 0)`,
          [sequenceId, step.id, prospect.id, mailboxId, slot],
        );

        await enqueueSend({ scheduledEmailId: result.insertId, sequenceId }, slot);
        scheduled++;
      } catch (err) {
        console.error(
          `[scheduler] step skipped for prospect ${prospect.id} at index ${i}:`,
          (err as Error).message,
        );
        skipped++;
      }
    }
  }

  return { scheduled, skipped };
}

// --- UTC window helpers (must match the bucketing in rateLimiter) ---------

function utcDayStr(d: Date): string {
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

function utcHourStr(d: Date): string {
  return `${utcDayStr(d)}T${d.getUTCHours()}`;
}

function startOfNextUTCDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0));
}

function startOfNextUTCHour(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1, 0, 0, 0),
  );
}

interface PendingRow extends RowDataPacket {
  id: number;
  prospect_id: number;
  mailbox_id: number;
  step_order: number;
  delay_days: number;
}

/**
 * Per-mailbox capacity tracker used while assigning send-times. The current
 * window's capacity is the *remaining* budget; any future window gets the
 * mailbox's full limit.
 */
export interface MailboxBudget {
  dailyLimit: number;
  hourlyLimit: number;
  dailyRemainingNow: number;
  hourlyRemainingNow: number;
  dayCounts: Map<string, number>;
  hourCounts: Map<string, number>;
}

/**
 * Pure slot allocator: return the earliest time >= max(desired, now) at which
 * both the day and hour windows for this mailbox have spare capacity, recording
 * the chosen slot in the budget's counters. Returns null if the mailbox can
 * never fit a send (a limit of 0) or a pathological backlog exhausts the guard,
 * so the caller skips it instead of looping forever. Exported for unit testing.
 */
export function nextAvailableSlot(
  budget: MailboxBudget,
  desired: Date,
  now: Date,
  todayKey: string,
  thisHourKey: string,
): Date | null {
  if (budget.dailyLimit <= 0 || budget.hourlyLimit <= 0) return null;

  let t = desired.getTime() < now.getTime() ? new Date(now.getTime()) : new Date(desired.getTime());
  // ~400 days of hourly rolls — generous upper bound; a real backlog converges
  // far sooner because every future window offers the mailbox's full limit.
  for (let guard = 0; guard < 24 * 400; guard++) {
    const dKey = utcDayStr(t);
    const hKey = utcHourStr(t);
    const dayCap = dKey === todayKey ? budget.dailyRemainingNow : budget.dailyLimit;
    const hourCap = hKey === thisHourKey ? budget.hourlyRemainingNow : budget.hourlyLimit;
    const dayUsed = budget.dayCounts.get(dKey) ?? 0;
    const hourUsed = budget.hourCounts.get(hKey) ?? 0;
    if (dayUsed >= dayCap) {
      t = startOfNextUTCDay(t);
      continue;
    }
    if (hourUsed >= hourCap) {
      t = startOfNextUTCHour(t);
      continue;
    }
    budget.dayCounts.set(dKey, dayUsed + 1);
    budget.hourCounts.set(hKey, hourUsed + 1);
    return t;
  }
  return null;
}

/** Stateful wrapper over nextAvailableSlot that lazily loads each mailbox's
 *  budget (DB limits + Redis remaining) and reuses it across calls. */
function createBudgetTracker(now: Date) {
  const todayKey = utcDayStr(now);
  const thisHourKey = utcHourStr(now);
  const budgets = new Map<number, MailboxBudget | null>();

  async function load(mailboxId: number): Promise<MailboxBudget | null> {
    if (budgets.has(mailboxId)) return budgets.get(mailboxId)!;
    const mb = await getMailbox(mailboxId);
    const rem = await remainingBudget(mailboxId);
    const b: MailboxBudget | null =
      mb && rem
        ? {
            dailyLimit: mb.daily_limit,
            hourlyLimit: mb.hourly_limit,
            dailyRemainingNow: rem.daily,
            hourlyRemainingNow: rem.hourly,
            dayCounts: new Map(),
            hourCounts: new Map(),
          }
        : null;
    budgets.set(mailboxId, b);
    return b;
  }

  return {
    async assign(mailboxId: number, desired: Date): Promise<Date | null> {
      const budget = await load(mailboxId);
      if (!budget) return null;
      return nextAvailableSlot(budget, desired, now, todayKey, thisHourKey);
    },
  };
}

/**
 * Resume a paused sequence. Re-schedules every remaining (pending) email:
 *  - delays are measured from NOW, not the original schedule — the first
 *    pending step per prospect fires at now + step.delay_days, and later steps
 *    cascade by their own delay_days;
 *  - per-mailbox remaining daily/hourly budget is respected (shared with
 *    scheduleSequence), so we never queue more sends into a window than that
 *    window can send. Overflow rolls forward to the next hour/day.
 *
 * Idempotent at the job level: each email is (re)enqueued under its deterministic
 * `se-<id>` jobId after removing any stale job with that id, so a duplicate
 * resume can't double-queue an email. The atomic claim in the worker is the
 * final backstop against double-sends.
 */
export async function resumeSequence(sequenceId: number): Promise<ScheduleResult> {
  const [rows] = await pool.execute<PendingRow[]>(
    `SELECT se.id, se.prospect_id, se.mailbox_id, st.step_order, st.delay_days
       FROM scheduled_emails se
       JOIN sequence_steps st ON st.id = se.step_id
      WHERE se.sequence_id = ? AND se.status = 'pending'
      ORDER BY se.prospect_id ASC, st.step_order ASC`,
    [sequenceId],
  );
  if (rows.length === 0) return { scheduled: 0, skipped: 0 };

  const now = new Date();
  const tracker = createBudgetTracker(now);

  let scheduled = 0;
  let skipped = 0;

  let currentProspect: number | null = null;
  let cascade = now; // desired send-time cursor for the current prospect

  for (const row of rows) {
    // Reset the cadence cursor at each prospect boundary; cascade by this
    // step's delay (the first remaining step fires at now + its delay_days).
    if (row.prospect_id !== currentProspect) {
      currentProspect = row.prospect_id;
      cascade = now;
    }
    cascade = computeNextSendTime(cascade, row.delay_days);

    const slot = await tracker.assign(row.mailbox_id, cascade);
    if (!slot) {
      skipped++;
      continue;
    }

    await pool.execute('UPDATE scheduled_emails SET scheduled_at = ? WHERE id = ?', [slot, row.id]);
    // Remove any stale job (a completed `se-<id>` kept by BullMQ, or a lingering
    // rate-limit retry) before re-adding, so the deterministic id is free.
    await sendQueue.remove(`se-${row.id}`).catch(() => {});
    await enqueueSend({ scheduledEmailId: row.id, sequenceId }, slot);
    scheduled++;
  }

  return { scheduled, skipped };
}

async function pickMailboxForSequence(sequenceId: number): Promise<number> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT m.id
       FROM sequences s
       JOIN mailboxes m ON m.user_id = s.user_id
      WHERE s.id = ?
      ORDER BY m.id ASC
      LIMIT 1`,
    [sequenceId],
  );
  if (rows.length === 0) {
    throw new Error('no mailbox available for sequence');
  }
  return rows[0].id as number;
}

/**
 * Cancel a sequence's not-yet-due (delayed) jobs. Filters on the job's own
 * `sequenceId` payload — the original did a DB lookup per delayed job (N+1) and
 * capped at 5000. Here we page through the whole delayed set. Jobs already
 * promoted to waiting/active are handled by the worker's pause guard instead.
 */
export async function cancelDelayedJobs(sequenceId: number): Promise<number> {
  const batch = 1000;
  let start = 0;
  const toRemove: Job[] = [];
  for (;;) {
    const jobs = await sendQueue.getDelayed(start, start + batch - 1);
    if (jobs.length === 0) break;
    for (const job of jobs) {
      if ((job.data as Partial<SendJobData> | undefined)?.sequenceId === sequenceId) {
        toRemove.push(job);
      }
    }
    if (jobs.length < batch) break;
    start += batch;
  }

  let cancelled = 0;
  for (const job of toRemove) {
    await job.remove().catch(() => {});
    cancelled++;
  }
  return cancelled;
}
