import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { pool } from '../config/db';
import { redis } from '../config/redis';
import { env } from '../config/env';
import { asyncHandler } from '../util/asyncHandler';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';

const router = Router();

const credsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

// Brute-force throttle: block a given (ip, email) pair after too many failed
// logins within the window. Only failures are counted; a success clears the
// counter. Keeps password guessing from being cheap.
const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_SECONDS = 15 * 60;

function loginThrottleKey(ip: string, email: string): string {
  return `login:fail:${ip}:${email}`;
}

router.post(
  '/register',
  asyncHandler(async (req, res) => {
    const parsed = credsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });
    const { email, password } = parsed.data;

    const hash = await bcrypt.hash(password, 10);
    try {
      const [result] = await pool.execute<ResultSetHeader>(
        'INSERT INTO users (email, password_hash) VALUES (?, ?)',
        [email.toLowerCase(), hash],
      );
      const token = jwt.sign({ sub: result.insertId }, env.jwtSecret, {
        expiresIn: env.jwtExpiresIn,
      } as jwt.SignOptions);
      return res.status(201).json({ token, user: { id: result.insertId, email } });
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'email_taken' });
      throw err;
    }
  }),
);

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const parsed = credsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });
    const { email, password } = parsed.data;
    const key = loginThrottleKey(req.ip ?? 'unknown', email.toLowerCase());

    const failures = Number((await redis.get(key)) ?? 0);
    if (failures >= LOGIN_MAX_FAILURES) {
      return res.status(429).json({ error: 'too_many_attempts' });
    }

    const [rows] = await pool.execute<RowDataPacket[]>(
      'SELECT id, password_hash FROM users WHERE email = ? LIMIT 1',
      [email.toLowerCase()],
    );
    const user = rows[0];
    const ok = user ? await bcrypt.compare(password, user.password_hash) : false;
    if (!ok) {
      const n = await redis.incr(key);
      if (n === 1) await redis.expire(key, LOGIN_WINDOW_SECONDS);
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    await redis.del(key); // successful login clears the failure counter
    const token = jwt.sign({ sub: user.id }, env.jwtSecret, {
      expiresIn: env.jwtExpiresIn,
    } as jwt.SignOptions);
    return res.json({ token, user: { id: user.id, email } });
  }),
);

export default router;
