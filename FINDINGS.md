# FINDINGS

Issues found while reviewing the existing code, in roughly descending severity.
Line numbers refer to the **fixed** files in this branch; each entry describes
the original defect and the fix applied.

---

### Rate limiter check + increment is not atomic (TOCTOU race)
- **File / line:** `backend/src/mailboxes/rateLimiter.ts:55-88`
- **Severity:** Critical
- **What's wrong:** The original read the daily/hourly counts with `GET`, compared
  them to the limit, then `INCR`ed in separate round-trips.
- **Why it's a bug (when does it manifest?):** The worker runs with
  `concurrency: 4` (`worker.ts:8`). Multiple jobs for the same mailbox can all
  `GET` an under-limit count, all pass the check, then all `INCR` — overshooting
  the limit. This is the headline concurrency bug; it appears precisely when a
  mailbox is near its limit and several sends fire at once.
- **Fix:** Moved check+increment into a single Lua script (`CHECK_AND_INCREMENT`)
  evaluated server-side, so the compare and the two `INCR`s are indivisible. TTLs
  are set on first creation of each window key.
- **How I verified:** `tests/rateLimiter.test.ts` fires 100 concurrent
  `checkAndIncrement` calls against a limit of 10 (real Redis) and asserts
  exactly 10 are allowed and the Redis counter is exactly 10.

---

### Insecure Direct Object Reference (IDOR) on scheduled-email lookup
- **File / line:** `backend/src/sequences/routes.ts:111-127`
- **Severity:** Critical
- **What's wrong:** `GET /scheduled-emails/:id` selected the row by `id` alone,
  with no ownership check.
- **Why it's a bug (when does it manifest?):** Any authenticated user could read
  any other user's scheduled email (subject metadata, prospect/mailbox ids,
  errors) by enumerating integer ids.
- **Fix:** Join to the parent `sequences` row and filter on `s.user_id = ?` so a
  row is only returned to its owner.
- **How I verified:** Code review of the query; the join restricts rows to the
  caller's `user_id`, matching the ownership pattern used elsewhere
  (`getSequenceForUser`).

---

### Quota double-consumed / email double-sent under concurrent jobs
- **File / line:** `backend/src/worker/processor.ts:80-92`
- **Severity:** High
- **What's wrong:** The worker checked `status === 'pending'` (a plain read), then
  consumed quota and sent. There was no atomic transition, so two jobs pointing
  at the same `scheduled_email` (possible via the resume path and the rate-limit
  retry path) could both pass the read and both send / both consume budget.
- **Why it's a bug (when does it manifest?):** Whenever two queue jobs reference
  the same row concurrently — e.g. a resume re-enqueue racing a lingering retry.
- **Fix:** Atomic claim — `UPDATE scheduled_emails SET status='processing' WHERE
  id=? AND status='pending'`. Exactly one caller gets `affectedRows === 1` and
  proceeds; the loser bails before consuming quota or sending.
- **How I verified:** `tests/processor.concurrency.test.ts` runs two
  `processSendJob` calls on the same pending row and asserts `send()` and the
  quota consume each happen exactly once.

---

### Pause does not stop already-enqueued (in-flight) jobs
- **File / line:** `backend/src/worker/processor.ts:67-78`
- **Severity:** High
- **What's wrong:** The worker query selected `s.status AS sequence_status` but
  never checked it. `cancelDelayedJobs` only removes *delayed* jobs, so any job
  already promoted to waiting/active when the user paused would still send.
- **Why it's a bug (when does it manifest?):** Pause a sequence while a send for
  it is due/in-flight → the email goes out anyway, violating the core pause
  guarantee.
- **Fix:** After loading the row, if `sequence_status !== 'active'`, log `paused`
  and return **without** sending, leaving the row `pending` so resume can
  reschedule it.
- **How I verified:** `tests/processor.concurrency.test.ts` "pause guard" asserts
  a paused sequence does not send and leaves the row `pending`.

---

### Rate-limited job is dropped forever (never re-enqueued)
- **File / line:** `backend/src/worker/processor.ts:94-120`
- **Severity:** High
- **What's wrong:** On a rate-limit hit the original threw without re-queuing.
  Jobs are added with no retry config, so the email stayed `pending` forever and
  never sent.
- **Why it's a bug (when does it manifest?):** Any time a mailbox hits its daily
  or hourly cap — every bounced email is silently lost.
- **Fix:** Release the claim back to `pending`, log `rate_limited`, and re-enqueue
  with a delay (1h for hourly, 1min for daily). `attempts` is **not** incremented
  for a bounce.
- **How I verified:** `tests/processor.concurrency.test.ts` "rate-limit handling"
  asserts the row returns to `pending`, `attempts` stays 0, and the job is
  re-enqueued.

---

### `send_logs` records "sent" before the email is actually sent
- **File / line:** `backend/src/worker/processor.ts:128-145`
- **Severity:** High
- **What's wrong:** The `'sent'` log row was inserted before calling `send()`,
  which simulates a 5% failure (`smtpAdapter.ts:11`).
- **Why it's a bug (when does it manifest?):** ~5% of the time the send throws but
  the log already says "sent" — corrupting delivery analytics and hiding real
  failures.
- **Fix:** Update `status='sent'` and insert the `'sent'` log **only after**
  `send()` resolves; on throw, mark `status='failed'` with the error.
- **How I verified:** Code review of the try/catch ordering; the success log is
  now inside the `try` after `await send(...)`.

---

### `computeNextSendTime` off by 1000× (seconds vs milliseconds)
- **File / line:** `backend/src/sequences/service.ts:84-88`
- **Severity:** High (Critical for resume)
- **What's wrong:** `prevSentAt.getTime() + delayDays*24*60*60` — `getTime()` is
  in ms but the delay was added in seconds (missing `* 1000`).
- **Why it's a bug (when does it manifest?):** Every resume cadence was ~1000×
  too short — a "1 day" delay became ~86 seconds, blasting the sequence almost
  immediately.
- **Fix:** Multiply by `1000` to convert days→ms.
- **How I verified:** Unit reasoning; 1 day = 86,400,000 ms. Exercised indirectly
  by the resume path.

---

### Scheduler loop skips the first step and reads an undefined step
- **File / line:** `backend/src/sequences/scheduler.ts:57-66`
- **Severity:** High
- **What's wrong:** Original `for (let i = 1; i <= steps.length; i++) steps[i]`
  skipped `steps[0]` and read `steps[steps.length]` (undefined → threw, swallowed
  by the try/catch as a "skipped" step). Additionally every step was scheduled at
  `from + thisStep.delay` rather than cascading from the previous step.
- **Why it's a bug (when does it manifest?):** Every scheduled sequence — the
  first email never goes out, one bogus step is counted as skipped, and step
  cadence is wrong (all relative to start instead of cumulative).
- **Fix:** `for (let i = 0; i < steps.length; i++)` and accumulate `offsetMs`
  across steps so each fires `delay_days` after the previous one.
- **How I verified:** Code review; loop now covers `0..length-1` and the running
  offset cascades delays.

---

### Rate limiter boundary off-by-one (allows limit + 1)
- **File / line:** `backend/src/mailboxes/rateLimiter.ts:58-59`
- **Severity:** Medium
- **What's wrong:** `if (count > limit)` rejected only after exceeding, allowing
  one extra send (the `limit + 1`-th).
- **Why it's a bug (when does it manifest?):** Every mailbox could send one more
  than its configured daily/hourly limit.
- **Fix:** `>=` so the send that would reach the limit is the last allowed one.
- **How I verified:** `tests/rateLimiter.test.ts` boundary test — limit 5 allows
  exactly 5, rejects the 6th.

---

### `readQuota` writes on read, leaking non-expiring keys
- **File / line:** `backend/src/mailboxes/rateLimiter.ts:97-116`
- **Severity:** Medium
- **What's wrong:** The GET-quota path did `SET key 0` with no TTL when a key was
  missing.
- **Why it's a bug (when does it manifest?):** Each quota read for an idle window
  created a permanent key (no expiry), so Redis accumulated one stale key per
  mailbox per day/hour forever. Also makes a read endpoint mutate state.
- **Fix:** Pure read — a missing key is treated as `0`, nothing is written.
- **How I verified:** `tests/rateLimiter.test.ts` asserts reading a fresh mailbox
  returns `used: 0` and creates **no** keys.

---

### Re-scheduling a sequence duplicates rows and jobs
- **File / line:** `backend/src/sequences/scheduler.ts:39-55`
- **Severity:** Medium
- **What's wrong:** `POST /:id/schedule` had no guard against existing
  `scheduled_emails`, so a double-click (or re-schedule after adding prospects)
  created a second full set of rows and jobs.
- **Why it's a bug (when does it manifest?):** Repeated `/schedule` calls →
  duplicate sends.
- **Fix:** Skip any prospect that already has `scheduled_emails` for the sequence
  (DISTINCT `prospect_id` set), making `/schedule` idempotent per prospect.
- **How I verified:** Code review of the dedupe set against `prospects`.

---

### JWT signing falls back to a hardcoded dev secret
- **File / line:** `backend/src/config/env.ts:9-17`
- **Severity:** Medium
- **What's wrong:** `jwtSecret` defaulted to `'dev-secret-do-not-use-in-prod'`
  when `JWT_SECRET` was unset.
- **Why it's a bug (when does it manifest?):** If deployed to production without
  the env var, every token is signed with a publicly-known secret → anyone can
  forge a valid JWT for any user.
- **Fix:** Fail fast — throw at startup if `NODE_ENV === 'production'` and
  `JWT_SECRET` is unset. The dev default remains for local convenience only.
- **How I verified:** Code review; the guard runs before `env` is exported.

---

### `attempts` counted for rate-limit bounces (not deliveries)
- **File / line:** `backend/src/worker/processor.ts:94-126`
- **Severity:** Low
- **What's wrong:** The original incremented `attempts` even when a job was only
  bounced by the rate limiter (no delivery attempted).
- **Why it's a bug (when does it manifest?):** Inflated `attempts` for busy
  mailboxes; would corrupt any future "give up after N attempts" logic.
- **Fix:** Increment `attempts` only after the rate-limit check passes and a real
  `send()` is about to happen.
- **How I verified:** `tests/processor.concurrency.test.ts` asserts `attempts`
  stays 0 on a rate-limit bounce.

---

### Timezone mismatch leaves scheduled jobs stuck in the delayed set
- **File / line:** `backend/src/config/db.ts:13-22`, `backend/scripts/setup-db.ts`
- **Severity:** High (environment-dependent; found during the live e2e run)
- **What's wrong:** mysql2 is configured with `timezone: 'Z'` (it converts DATETIME
  values to/from UTC), and the whole app buckets on UTC (`getUTCHours`, etc.). But
  MySQL's session `time_zone` defaults to `SYSTEM`, so server-side `NOW()` /
  `CURRENT_TIMESTAMP` and DATETIME round-trips use the host's local offset.
- **Why it's a bug (when does it manifest?):** On any non-UTC host. The seed's
  `scheduled_at = NOW()` stored local wall-clock (e.g. `23:31` IST); mysql2 read it
  back as `23:31 UTC` — ~5.5h in the future — so every pre-scheduled job sat in
  BullMQ's `delayed` set and the worker dispatched nothing. Silent on a UTC box,
  broken everywhere else.
- **Fix:** Pin every connection's session time zone to UTC
  (`SET time_zone = '+00:00'`) — on the pool via a `connection` handler and in the
  setup script for both connections. DB-side time now agrees with the JS side.
- **How I verified:** Before: `scheduled_at` read as `23:31`, jobs stuck delayed,
  worker idle. After: `scheduled_at` stored/read as `18:05` UTC, delay ≈ 0, worker
  dispatched all 3 seed emails (`status='sent'`).

---

### Schedule activates the sequence *after* enqueuing — delay-0 first step stranded
- **File / line:** `backend/src/sequences/scheduler.ts:48-63`
- **Severity:** High (found during the live e2e run)
- **What's wrong:** `scheduleSequence` inserted rows and enqueued jobs first, then
  flipped the sequence `draft -> active` at the very end.
- **Why it's a bug (when does it manifest?):** A first step with `delay_days = 0`
  produces a zero-delay job. The worker can pick it up before the activation runs,
  see `sequence_status = 'draft'`, and the pause guard (correctly) holds the send,
  leaving the row `pending` — but the job has been consumed and is never
  re-enqueued, so that email is **stuck pending forever**. This is the common case
  (first email sends immediately), so it bites real usage, not an edge case.
- **Fix:** Promote `draft -> active` **before** the enqueue loop, so the worker
  always observes `active` for any job it can immediately pick up.
- **How I verified:** Before the fix, scheduling seq 2 logged `paused / "sequence
  draft"` for all three delay-0 step-1 rows and left them pending. After the fix, a
  fresh sequence with a delay-0 step scheduled and **sent immediately**
  (`status='sent'`, log `Email dispatched`), with no `paused` log.

---

### Build/typecheck broken by stricter dependency types (stabilization)
- **File / line:** `backend/src/auth/middleware.ts:16`,
  `backend/src/mailboxes/routes.ts:12,29,38`, `backend/src/sequences/routes.ts:116`
- **Severity:** Medium
- **What's wrong:** A fresh install resolves newer `mysql2` (stricter
  `ExecuteValues` that rejects `number | undefined`) and `@types/jsonwebtoken`
  (verify returns `string | JwtPayload`), so `npm run typecheck` failed on
  existing code.
- **Why it's a bug (when does it manifest?):** The documented `typecheck`/`build`
  scripts fail out of the box on a clean checkout.
- **Fix:** Add `req.userId!` (these handlers run behind `requireAuth`, which
  guarantees it) and cast `jwt.verify(...)` through `unknown`. No runtime change.
- **How I verified:** `npm run typecheck` now exits 0.

---

## Reviewed and found OK (not bugs)
- SQL uses parameterized queries throughout — no injection found.
- Ownership checks are present on sequence and mailbox routes (the one gap was
  the IDOR above).
- DB pool and setup script both use `timezone: 'Z'`, matching the UTC window keys
  in the rate limiter / scheduler — no timezone skew between writes and buckets.
