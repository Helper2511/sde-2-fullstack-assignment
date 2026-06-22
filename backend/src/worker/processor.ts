import type { Job } from 'bullmq';
import { pool } from '../config/db';
import { checkAndIncrement } from '../mailboxes/rateLimiter';
import { sendQueue, type SendJobData } from '../sequences/scheduler';
import { send } from './smtpAdapter';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';

type SendJob = SendJobData;

interface JoinedRow extends RowDataPacket {
  id: number;
  sequence_id: number;
  step_id: number;
  prospect_id: number;
  mailbox_id: number;
  status: string;
  attempts: number;
  subject: string;
  body: string;
  prospect_email: string;
  prospect_status: string;
  mailbox_email: string;
  sequence_status: string;
}

export async function processSendJob(job: Job<SendJob>): Promise<void> {
  const { scheduledEmailId } = job.data;

  const [rows] = await pool.execute<JoinedRow[]>(
    `SELECT se.id, se.sequence_id, se.step_id, se.prospect_id, se.mailbox_id,
            se.status, se.attempts,
            st.subject, st.body,
            p.email AS prospect_email, p.status AS prospect_status,
            m.email AS mailbox_email,
            s.status AS sequence_status
       FROM scheduled_emails se
       JOIN sequence_steps st ON st.id = se.step_id
       JOIN prospects p ON p.id = se.prospect_id
       JOIN mailboxes m ON m.id = se.mailbox_id
       JOIN sequences s ON s.id = se.sequence_id
      WHERE se.id = ?
      LIMIT 1`,
    [scheduledEmailId],
  );
  const row = rows[0];
  if (!row) {
    console.warn(`[worker] scheduled_email ${scheduledEmailId} not found`);
    return;
  }
  if (row.status !== 'pending') {
    return;
  }
  if (row.prospect_status !== 'active') {
    await pool.execute(
      "UPDATE scheduled_emails SET status='skipped' WHERE id=?",
      [row.id],
    );
    await pool.execute(
      'INSERT INTO send_logs (scheduled_email_id, mailbox_id, status, message) VALUES (?, ?, ?, ?)',
      [row.id, row.mailbox_id, 'skipped', `prospect ${row.prospect_status}`],
    );
    return;
  }

  // Respect pause for already-enqueued jobs. The query joins `sequences` and
  // selects `sequence_status`, but the original code never checked it, so a job
  // that promoted from delayed->waiting before/while the sequence was paused
  // would still send. Leave the row 'pending' (do NOT mark 'skipped') so the
  // resume flow can re-schedule it.
  if (row.sequence_status !== 'active') {
    await pool.execute(
      'INSERT INTO send_logs (scheduled_email_id, mailbox_id, status, message) VALUES (?, ?, ?, ?)',
      [row.id, row.mailbox_id, 'paused', `sequence ${row.sequence_status}`],
    );
    return;
  }

  // Atomically claim the row. Resume and the rate-limit retry path can both
  // leave a queue job pointing at the same scheduled_email, so two workers may
  // pick it up concurrently. The conditional UPDATE lets exactly one win; the
  // loser sees affectedRows === 0 and bails before consuming any quota. This
  // closes the read-then-write gap between the `status === 'pending'` check
  // above and the send below.
  const [claim] = await pool.execute<ResultSetHeader>(
    "UPDATE scheduled_emails SET status='processing', claimed_at=NOW() WHERE id = ? AND status = 'pending'",
    [row.id],
  );
  if (claim.affectedRows === 0) {
    return;
  }

  const check = await checkAndIncrement(row.mailbox_id);
  if (!check.allowed) {
    // Rate limited: release the claim back to 'pending' and re-enqueue with a
    // short delay. The original threw without re-queuing, and jobs are added
    // with no retry config, so the email would be stuck 'pending' forever.
    // attempts is NOT incremented here — a rate-limit bounce is not a delivery
    // attempt.
    await pool.execute(
      "UPDATE scheduled_emails SET status='pending', claimed_at=NULL WHERE id = ?",
      [row.id],
    );
    await pool.execute(
      'INSERT INTO send_logs (scheduled_email_id, mailbox_id, status, message) VALUES (?, ?, ?, ?)',
      [row.id, row.mailbox_id, 'rate_limited', `limit hit: ${check.reason}`],
    );
    // No fixed jobId here: `se-${row.id}` already exists (this very job) and
    // BullMQ keeps completed jobs, so re-adding that id would be a silent no-op.
    // A fresh auto-id is still cancellable on pause because cancelDelayedJobs
    // matches on job.data.scheduledEmailId, not the jobId.
    const retryDelay = check.reason === 'hourly' ? 60 * 60 * 1000 : 60 * 1000;
    await sendQueue.add(
      'send',
      { scheduledEmailId: row.id, sequenceId: row.sequence_id },
      { delay: retryDelay },
    );
    return;
  }

  // We're now genuinely attempting delivery — count the attempt.
  await pool.execute(
    'UPDATE scheduled_emails SET attempts = attempts + 1 WHERE id = ?',
    [row.id],
  );

  try {
    await send({
      from: row.mailbox_email,
      to: row.prospect_email,
      subject: row.subject,
      body: row.body,
    });
    // Log 'sent' only after the send actually succeeds. The original logged
    // 'sent' before calling send(), so the simulated 5% failures were recorded
    // as successful deliveries.
    await pool.execute(
      "UPDATE scheduled_emails SET status='sent', sent_at=NOW() WHERE id = ?",
      [row.id],
    );
    await pool.execute(
      'INSERT INTO send_logs (scheduled_email_id, mailbox_id, status, message) VALUES (?, ?, ?, ?)',
      [row.id, row.mailbox_id, 'sent', 'Email dispatched'],
    );
  } catch (err) {
    const message = (err as Error).message;
    await pool.execute(
      "UPDATE scheduled_emails SET status='failed', last_error=? WHERE id = ?",
      [message, row.id],
    );
    throw err;
  }
}

/**
 * Recover rows stranded in 'processing' by a worker that died mid-send (between
 * the atomic claim and the terminal status update). Such rows have no live job
 * and resume only touches 'pending', so without this they'd never send. Any row
 * whose claim is older than the lease is returned to 'pending' and re-enqueued.
 *
 * The lease must comfortably exceed the worst-case job duration: a send that is
 * merely slow (not dead) must not be reclaimed, or it could be sent twice. This
 * is the standard at-least-once trade-off — a short window of double-send risk
 * in exchange for never silently dropping a stuck email.
 */
export async function reapStuckProcessing(leaseSeconds = 120): Promise<number> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT id, sequence_id FROM scheduled_emails
      WHERE status = 'processing'
        AND claimed_at IS NOT NULL
        AND claimed_at < (NOW() - INTERVAL ? SECOND)`,
    [leaseSeconds],
  );

  let reaped = 0;
  for (const r of rows as Array<{ id: number; sequence_id: number }>) {
    // Conditional reset so we don't fight a worker that just finished the row.
    const [res] = await pool.execute<ResultSetHeader>(
      "UPDATE scheduled_emails SET status='pending', claimed_at=NULL WHERE id = ? AND status = 'processing'",
      [r.id],
    );
    if (res.affectedRows === 1) {
      await sendQueue.remove(`se-${r.id}`).catch(() => {});
      await sendQueue.add(
        'send',
        { scheduledEmailId: r.id, sequenceId: r.sequence_id },
        { delay: 0, jobId: `se-${r.id}` },
      );
      reaped++;
    }
  }
  return reaped;
}
