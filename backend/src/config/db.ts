import mysql from 'mysql2/promise';
import { env } from './env';

export const pool = mysql.createPool({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database: env.db.database,
  waitForConnections: true,
  connectionLimit: 10,
  enableKeepAlive: true,
  dateStrings: false,
  timezone: 'Z',
});

// The app treats every timestamp as UTC: the pool uses `timezone: 'Z'` (JS<->SQL
// string conversion assumes UTC) and the rate limiter/scheduler bucket on UTC
// hours/days. MySQL's session time_zone defaults to SYSTEM, though, so server-side
// NOW()/CURRENT_TIMESTAMP and DATETIME round-trips are skewed by the host's local
// offset (e.g. a NOW() seed on an IST box reads back ~5.5h in the future, leaving
// jobs stuck in BullMQ's delayed set). Pin each pooled connection to UTC so the
// DB side agrees with the JS side.
pool.on('connection', (conn) => {
  // The 'connection' event hands back the *core* (callback-style) connection even
  // on a promise pool, so its query() takes a callback and returns an emitter
  // (not a promise) — hence the cast. Fire-and-forget is safe: mysql2 serializes
  // commands per connection, so this runs before any query handed out on it. The
  // empty callback swallows any error instead of letting it crash the process.
  (conn as unknown as { query: (sql: string, cb: (err: unknown) => void) => void }).query(
    "SET time_zone = '+00:00'",
    () => {},
  );
});

export type Db = mysql.Pool;
