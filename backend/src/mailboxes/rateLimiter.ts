import { redis } from '../config/redis';
import { pool } from '../config/db';
import type { RowDataPacket } from 'mysql2';

export interface Mailbox {
    id: number;
    user_id: number;
    email: string;
    daily_limit: number;
    hourly_limit: number;
}

export type LimitReason = 'daily' | 'hourly';
export type CheckResult =
    | { allowed: true }
    | { allowed: false; reason: LimitReason };

function dayKey(mailboxId: number, now = new Date()): string {
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const d = String(now.getUTCDate()).padStart(2, '0');
    return `rl:daily:${mailboxId}:${y}-${m}-${d}`;
}

function hourKey(mailboxId: number, now = new Date()): string {
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const d = String(now.getUTCDate()).padStart(2, '0');
    const h = String(now.getUTCHours()).padStart(2, '0');
    return `rl:hourly:${mailboxId}:${y}-${m}-${d}T${h}`;
}

export async function getMailbox(mailboxId: number): Promise<Mailbox | null> {
    const [rows] = await pool.execute<RowDataPacket[]>(
        'SELECT id, user_id, email, daily_limit, hourly_limit FROM mailboxes WHERE id = ?',
        [mailboxId],
    );
    return (rows[0] as Mailbox) ?? null;
}

/**
 * Atomically check both limits and, only if both pass, increment both counters
 * (setting a TTL when each window key is first created). Runs as a single Lua
 * script so check+increment is indivisible: with multiple concurrent workers,
 * no two callers can both observe an under-limit count and then both increment
 * past the limit (the TOCTOU race in the original GET/GET/INCR sequence).
 *
 * The comparison is `>=` so the Nth send (when count already equals the limit)
 * is rejected — the original `>` allowed one extra send (limit + 1).
 *
 * KEYS[1]=dailyKey KEYS[2]=hourlyKey
 * ARGV[1]=dailyLimit ARGV[2]=hourlyLimit ARGV[3]=dailyTtl ARGV[4]=hourlyTtl
 * Returns: 0 = allowed, 1 = daily limit hit, 2 = hourly limit hit.
 */
const CHECK_AND_INCREMENT = `
local daily = tonumber(redis.call('GET', KEYS[1]) or '0')
local hourly = tonumber(redis.call('GET', KEYS[2]) or '0')
if daily >= tonumber(ARGV[1]) then return 1 end
if hourly >= tonumber(ARGV[2]) then return 2 end
local newDaily = redis.call('INCR', KEYS[1])
if newDaily == 1 then redis.call('EXPIRE', KEYS[1], ARGV[3]) end
local newHourly = redis.call('INCR', KEYS[2])
if newHourly == 1 then redis.call('EXPIRE', KEYS[2], ARGV[4]) end
return 0
`;

export async function checkAndIncrement(mailboxId: number): Promise<CheckResult> {
    const mailbox = await getMailbox(mailboxId);
    if (!mailbox) return { allowed: false, reason: 'daily' };

    const dKey = dayKey(mailboxId);
    const hKey = hourKey(mailboxId);

    const result = (await redis.eval(
        CHECK_AND_INCREMENT,
        2,
        dKey,
        hKey,
        mailbox.daily_limit,
        mailbox.hourly_limit,
        86400,
        3600,
    )) as number;

    if (result === 1) return { allowed: false, reason: 'daily' };
    if (result === 2) return { allowed: false, reason: 'hourly' };
    return { allowed: true };
}

export interface QuotaSnapshot {
    mailboxId: number;
    email: string;
    daily: { used: number; limit: number };
    hourly: { used: number; limit: number };
}

export async function readQuota(mailboxId: number): Promise<QuotaSnapshot | null> {
    const mailbox = await getMailbox(mailboxId);
    if (!mailbox) return null;

    const dKey = dayKey(mailboxId);
    const hKey = hourKey(mailboxId);

    // Pure read: a missing key simply means zero sends this window. We must NOT
    // write here — the original `SET key 0` (with no TTL) created keys that
    // never expired, leaking one key per mailbox per day/hour forever.
    const dailyRaw = await redis.get(dKey);
    const hourlyRaw = await redis.get(hKey);

    return {
        mailboxId,
        email: mailbox.email,
        daily: { used: parseInt(dailyRaw ?? '0', 10), limit: mailbox.daily_limit },
        hourly: { used: parseInt(hourlyRaw ?? '0', 10), limit: mailbox.hourly_limit },
    };
}

/**
 * Approximate remaining budget for a mailbox in a given window. Used by the
 * resume code path to decide how many sends to schedule "today".
 */
export async function remainingBudget(mailboxId: number): Promise<{
    daily: number;
    hourly: number;
} | null> {
    const snapshot = await readQuota(mailboxId);
    if (!snapshot) return null;
    return {
        daily: Math.max(0, snapshot.daily.limit - snapshot.daily.used),
        hourly: Math.max(0, snapshot.hourly.limit - snapshot.hourly.used),
    };
}
