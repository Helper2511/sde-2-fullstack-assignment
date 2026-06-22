import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../config/db';
import { requireAuth, AuthedRequest } from '../auth/middleware';
import { asyncHandler } from '../util/asyncHandler';
import {
  getSequenceForUser,
  listSequencesForUser,
  createSequence,
  getSteps,
  getProspects,
  setSequenceStatus,
} from './service';
import { scheduleSequence, resumeSequence, cancelDelayedJobs } from './scheduler';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';

const router = Router();
router.use(requireAuth);

router.get(
  '/',
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await listSequencesForUser(req.userId!));
  }),
);

router.post(
  '/',
  asyncHandler(async (req: AuthedRequest, res) => {
    const parsed = z.object({ name: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });
    const id = await createSequence(req.userId!, parsed.data.name);
    res.status(201).json({ id });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req: AuthedRequest, res) => {
    const seq = await getSequenceForUser(Number(req.params.id), req.userId!);
    if (!seq) return res.status(404).json({ error: 'not_found' });
    const [steps, prospects] = await Promise.all([getSteps(seq.id), getProspects(seq.id)]);
    res.json({ ...seq, steps, prospects });
  }),
);

router.get(
  '/:id/steps',
  asyncHandler(async (req: AuthedRequest, res) => {
    const seq = await getSequenceForUser(Number(req.params.id), req.userId!);
    if (!seq) return res.status(404).json({ error: 'not_found' });
    res.json(await getSteps(seq.id));
  }),
);

const stepSchema = z.object({
  step_order: z.number().int().positive(),
  delay_days: z.number().int().min(0),
  subject: z.string().min(1),
  body: z.string().min(1),
});

router.post(
  '/:id/steps',
  asyncHandler(async (req: AuthedRequest, res) => {
    const seq = await getSequenceForUser(Number(req.params.id), req.userId!);
    if (!seq) return res.status(404).json({ error: 'not_found' });
    const parsed = stepSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });
    const { step_order, delay_days, subject, body } = parsed.data;
    const [result] = await pool.execute<ResultSetHeader>(
      'INSERT INTO sequence_steps (sequence_id, step_order, delay_days, subject, body) VALUES (?, ?, ?, ?, ?)',
      [seq.id, step_order, delay_days, subject, body],
    );
    res.status(201).json({ id: result.insertId });
  }),
);

router.get(
  '/:id/scheduled-emails',
  asyncHandler(async (req: AuthedRequest, res) => {
    const seq = await getSequenceForUser(Number(req.params.id), req.userId!);
    if (!seq) return res.status(404).json({ error: 'not_found' });
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT id, step_id, prospect_id, mailbox_id, scheduled_at, status, attempts, last_error, sent_at
         FROM scheduled_emails
        WHERE sequence_id = ?
        ORDER BY scheduled_at ASC, id ASC
        LIMIT 500`,
      [seq.id],
    );
    res.json(rows);
  }),
);

router.post(
  '/:id/schedule',
  asyncHandler(async (req: AuthedRequest, res) => {
    const seq = await getSequenceForUser(Number(req.params.id), req.userId!);
    if (!seq) return res.status(404).json({ error: 'not_found' });
    const result = await scheduleSequence({ sequenceId: seq.id });
    res.json(result);
  }),
);

router.post(
  '/:id/pause',
  asyncHandler(async (req: AuthedRequest, res) => {
    const seq = await getSequenceForUser(Number(req.params.id), req.userId!);
    if (!seq) return res.status(404).json({ error: 'not_found' });
    if (seq.status === 'paused') return res.json({ ok: true, alreadyPaused: true });

    await setSequenceStatus(seq.id, 'paused');
    const cancelled = await cancelDelayedJobs(seq.id);
    res.json({ ok: true, cancelled });
  }),
);

router.post(
  '/:id/resume',
  asyncHandler(async (req: AuthedRequest, res) => {
    const seq = await getSequenceForUser(Number(req.params.id), req.userId!);
    if (!seq) return res.status(404).json({ error: 'not_found' });
    if (seq.status !== 'paused') return res.json({ ok: true, alreadyActive: true });

    await setSequenceStatus(seq.id, 'active');
    const result = await resumeSequence(seq.id);
    res.json({ ok: true, ...result });
  }),
);

// Used by the sequence-detail panel to refresh a single email's status.
const scheduledEmailRouter = Router();
scheduledEmailRouter.use(requireAuth);

scheduledEmailRouter.get(
  '/:id',
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = Number(req.params.id);
    // Scope by owner: join to the parent sequence and filter on the caller's
    // user_id. The original query selected by id alone, letting any authenticated
    // user read any other user's scheduled emails by enumerating ids (IDOR).
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT se.id, se.sequence_id, se.step_id, se.prospect_id, se.mailbox_id,
              se.scheduled_at, se.status, se.attempts, se.last_error, se.sent_at
         FROM scheduled_emails se
         JOIN sequences s ON s.id = se.sequence_id
        WHERE se.id = ? AND s.user_id = ?
        LIMIT 1`,
      [id, req.userId!],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
    res.json(rows[0]);
  }),
);

export { scheduledEmailRouter };
export default router;
