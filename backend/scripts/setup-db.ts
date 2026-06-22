/**
 * Database setup: create the database (if needed), apply schema.sql, then
 * seed.sql, and enqueue BullMQ jobs for any pre-scheduled (pending) emails so
 * the worker has immediate work — see README "Setup".
 *
 * Usage: npm run setup:db   (from repo root or the backend workspace)
 */
import fs from 'fs';
import path from 'path';
import mysql from 'mysql2/promise';
import { Queue } from 'bullmq';
import { env } from '../src/config/env';

const SEND_QUEUE = 'email-send';
const sqlDir = path.join(__dirname, '..', 'src', 'db');

function readSql(name: string): string {
  return fs.readFileSync(path.join(sqlDir, name), 'utf8');
}

async function applySchemaAndSeed(): Promise<void> {
  // Connect without selecting a database so we can create it if it's missing.
  const conn = await mysql.createConnection({
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    multipleStatements: true,
    timezone: 'Z',
  });

  try {
    // Match the app's UTC assumption so the seed's NOW() is stored as UTC and
    // round-trips correctly (see config/db.ts for the full rationale).
    await conn.query("SET time_zone = '+00:00'");
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${env.db.database}\` ` +
        `CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    await conn.query(`USE \`${env.db.database}\``);

    console.log(`[setup:db] applying schema.sql to "${env.db.database}"`);
    await conn.query(readSql('schema.sql'));

    console.log('[setup:db] applying seed.sql');
    await conn.query(readSql('seed.sql'));
  } finally {
    await conn.end();
  }
}

/**
 * Enqueue a BullMQ job for every pending scheduled_email so the worker picks
 * them up. Best-effort: if Redis is unreachable the DB is still set up and we
 * warn instead of failing the whole script.
 */
async function enqueuePendingSends(): Promise<void> {
  const conn = await mysql.createConnection({
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database: env.db.database,
    timezone: 'Z',
  });
  await conn.query("SET time_zone = '+00:00'");

  const queue = new Queue(SEND_QUEUE, {
    connection: { host: env.redis.host, port: env.redis.port },
  });

  try {
    const [rows] = await conn.query(
      "SELECT id, sequence_id, scheduled_at FROM scheduled_emails WHERE status = 'pending'",
    );
    const pending = rows as Array<{ id: number; sequence_id: number; scheduled_at: Date }>;

    for (const row of pending) {
      const delay = Math.max(0, new Date(row.scheduled_at).getTime() - Date.now());
      await queue.add(
        'send',
        { scheduledEmailId: row.id, sequenceId: row.sequence_id },
        { delay, jobId: `se-${row.id}` },
      );
    }
    console.log(`[setup:db] enqueued ${pending.length} pending send job(s)`);
  } catch (err) {
    console.warn(
      `[setup:db] could not enqueue pending sends (is Redis running?): ${
        (err as Error).message
      }`,
    );
  } finally {
    await queue.close();
    await conn.end();
  }
}

async function main(): Promise<void> {
  await applySchemaAndSeed();
  await enqueuePendingSends();
  console.log('[setup:db] done.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[setup:db] failed:', err);
    process.exit(1);
  });
