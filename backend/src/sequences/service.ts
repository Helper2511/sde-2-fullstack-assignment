import { pool } from '../config/db';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';

export interface Sequence {
  id: number;
  user_id: number;
  name: string;
  status: 'draft' | 'active' | 'paused' | 'completed';
}

export interface Step {
  id: number;
  sequence_id: number;
  step_order: number;
  delay_days: number;
  subject: string;
  body: string;
}

export interface Prospect {
  id: number;
  sequence_id: number;
  email: string;
  name: string | null;
  status: 'active' | 'unsubscribed' | 'bounced';
}

export async function getSequenceForUser(
  sequenceId: number,
  userId: number,
): Promise<Sequence | null> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT id, user_id, name, status FROM sequences WHERE id = ? AND user_id = ? LIMIT 1',
    [sequenceId, userId],
  );
  return (rows[0] as Sequence) ?? null;
}

export async function listSequencesForUser(userId: number): Promise<Sequence[]> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT id, user_id, name, status, created_at FROM sequences WHERE user_id = ? ORDER BY id DESC',
    [userId],
  );
  return rows as Sequence[];
}

export async function createSequence(userId: number, name: string): Promise<number> {
  const [result] = await pool.execute<ResultSetHeader>(
    "INSERT INTO sequences (user_id, name, status) VALUES (?, ?, 'draft')",
    [userId, name],
  );
  return result.insertId;
}

export async function getSteps(sequenceId: number): Promise<Step[]> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT id, sequence_id, step_order, delay_days, subject, body FROM sequence_steps WHERE sequence_id = ? ORDER BY step_order ASC',
    [sequenceId],
  );
  return rows as Step[];
}

export async function getProspects(sequenceId: number): Promise<Prospect[]> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT id, sequence_id, email, name, status FROM prospects WHERE sequence_id = ? ORDER BY id',
    [sequenceId],
  );
  return rows as Prospect[];
}

export async function setSequenceStatus(
  sequenceId: number,
  status: Sequence['status'],
): Promise<void> {
  await pool.execute('UPDATE sequences SET status = ? WHERE id = ?', [status, sequenceId]);
}

/**
 * Compute when the next email in a sequence should go out given the previous
 * send time and the next step's configured `delay_days`. Used by the resume
 * code path so that paused sequences pick up from "now + delay" rather than
 * blasting all queued emails the moment the user clicks Resume.
 */
export function computeNextSendTime(prevSentAt: Date, delayDays: number): Date {
  // getTime() is in milliseconds, so the delay must be converted to ms too.
  // The original omitted the `* 1000`, making "1 day" ~86 seconds (1000x short).
  return new Date(prevSentAt.getTime() + delayDays * 24 * 60 * 60 * 1000);
}
