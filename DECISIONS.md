# DECISIONS

## Test framework

**vitest.** Chosen because the codebase is TypeScript run through `tsx`/esbuild;
vitest uses the same esbuild transform, so tests run without a separate `ts-jest`
toolchain or build step. Its `vi.mock` hoisting and `vi.hoisted` made it easy to
swap the MySQL pool for an in-memory store while keeping the real Redis client.

- `npm test` (in `backend/`) runs `vitest run`.
- Rate-limiter tests run the **real Lua script against a real local Redis** — the
  headline race only exists at the Redis layer, and ioredis-mock's Lua support is
  incomplete, so a mock would give false confidence. The suite **auto-skips** if
  Redis is unreachable (top-level ping probe with a 2s timeout) so it never fails
  red on a machine without Redis.
- The MySQL dependency is mocked (no DB needed to run the suite).

---

## Pause / Resume

### Pause — stopping in-flight work
Pause has two layers:
1. `cancelDelayedJobs` removes jobs still sitting in BullMQ's *delayed* set (the
   bulk of not-yet-due sends).
2. The worker re-checks `sequence_status` after loading the row and bails if it
   isn't `active`. This is the cheap "respect pause as soon as possible" guard for
   jobs that already promoted to waiting/active and are therefore unreachable by
   `cancelDelayedJobs`.

**Trade-off:** a job that bailed on the pause guard leaves its row `pending` (not
`skipped`), so resume can reschedule it. I deliberately did **not** try to abort
a send already in `processing` — once `send()` is in flight there's no safe
cancellation, and the atomic claim means at most one such send exists per row.

**Why poll the status in the worker instead of draining the queue on pause?**
Draining waiting/active jobs is racy (a job can promote between read and remove)
and BullMQ has no atomic "remove all jobs for sequence X". A status check at the
point of send is simpler and strictly correct: the DB is the source of truth.

### Resume — recomputing send times
- Only `pending` rows are rescheduled, ordered by `(prospect_id, step_order)`.
- Delays are measured **from now**: the first remaining step per prospect fires at
  `now + delay_days`, later steps cascade by their own `delay_days`
  (`computeNextSendTime`). Resuming does not blast everything immediately.
- **Per-mailbox budget** is respected. The current window uses the *remaining*
  daily/hourly budget (from Redis counters); future windows get the full limit.
  When a window is full, the send rolls forward to the next hour/day. This avoids
  queueing 500 sends today onto a `daily_limit=100` mailbox.
- Idempotency: each row is re-enqueued under its deterministic `se-<id>` jobId
  after removing any stale job with that id, so a double-resume can't double-queue.
  The worker's atomic claim is the final backstop.

**Budget trade-off (spillover vs. drop):** overflow **rolls forward** to the next
window rather than being dropped. Assumption: the user wants every remaining email
sent eventually, just rate-limited — not silently discarded. The roll-forward loop
is bounded (`guard < 3660`) to prevent pathological spin if limits are zero.

**Known limitation — `processing`-stuck rows:** if the worker crashes between the
atomic claim and the terminal status update, a row can stay `processing`. Resume
only reschedules `pending` rows, so it won't recover these. With more time I'd add
a reaper that returns rows stuck in `processing` past a lease timeout back to
`pending` (or use a visibility-timeout pattern).

---

## Quota (Task 4)

**Frontend UI intentionally skipped.** No `frontend/` directory exists in the repo
(the root `package.json` declares the workspace and the assignment references
`frontend/src/pages/MailboxQuota.tsx`, but the previous engineer never committed
it). Per direction this take-home is scoped to the backend; building a Vite/React
app from scratch was out of scope. The backend endpoint is reviewed and hardened
so the UI could be dropped on top with no backend changes.

**What the UI would have done (and the refresh decision):**
- Render each owned mailbox: email, daily used/limit, hourly used/limit, with a
  visual warning at ≥80% of either limit.
- **Refresh strategy: short-interval polling (~10–15s), pause when the tab is
  hidden.** Justification: quota counters change only as the worker sends (seconds
  granularity, not sub-second), the data is per-user and cheap, and the values are
  already approximate. Polling is far simpler than SSE/WebSockets for data that is
  inherently a slowly-moving counter, and a hidden-tab pause avoids needless load.
  Staleness of a few seconds is acceptable for a quota dashboard.

**Backend hardening:** `readQuota` was made a pure read (see FINDINGS) so hitting
the quota endpoint never mutates Redis. The endpoint already checks ownership.

---

## Post-review hardening pass

After a self-review of the diff, the following robustness gaps were fixed (all
verified by typecheck + tests + the live e2e):

- **Async errors now reach the error handler.** Express 4 does not await `async`
  route handlers, so a rejected handler became an unhandled rejection and the
  client hung. Added `util/asyncHandler.ts` and wrapped every route; rejections
  now hit the central handler in `index.ts`.
- **Unified schedule/resume budget logic.** The initial `scheduleSequence`
  previously ignored mailbox limits and relied on the rate limiter bouncing the
  overflow (a 1-minute retry storm). Both paths now share one pure allocator
  (`nextAvailableSlot`) + a stateful `createBudgetTracker`, so the initial
  schedule also spreads sends across windows. Verified: 15 sends on a 10/hour
  mailbox were spread 10 + 5 across two hours instead of dumped at once.
- **`processing`-stuck reaper.** Added a `claimed_at` column; the atomic claim
  stamps it; `reapStuckProcessing` (run every 60s in the worker) returns rows
  whose claim is older than a 120s lease to `pending` and re-enqueues them.
  Lease > worst-case job time, so a slow-but-alive send isn't reclaimed
  (at-least-once trade-off, documented in code). Verified live.
- **`cancelDelayedJobs` no longer N+1.** Jobs now carry `sequenceId`, so pause
  filters delayed jobs on the payload (paginated, no 5000 cap) instead of a
  per-job DB lookup. Verified: pausing a 15-job sequence cancelled all 15.
- **Security:** CORS restricted to an env allowlist (`CORS_ORIGINS`, default the
  Vite dev origin); Redis-backed brute-force throttle on `/auth/login`
  (10 failures / 15 min per ip+email, cleared on success).
- **Cleanup:** removed the dead `_typeBrand()` export.

## Consciously NOT fixed (and why)

- **Genuine `send()` failure is terminal.** On a real SMTP throw the row goes to
  `failed` and the error rethrows, but jobs are added with no BullMQ retry config,
  so the simulated 5% failures are not retried. For a take-home this is acceptable
  and visible (status `failed`, `last_error` set). With more time I'd add bounded
  retries with backoff distinct from the rate-limit re-enqueue. Left as-is to keep
  the fix surface minimal and the failure observable. (Note: a *crashed* worker is
  now recovered by the reaper; this item is only about a send that genuinely throws.)
- **`pickMailboxForSequence` always picks the lowest mailbox id.** No load
  balancing across a user's mailboxes. Out of scope; noted for awareness.

---

## What I'd do with another day
1. Bounded retry-with-backoff for genuine send failures (distinct from the
   rate-limit and reaper re-enqueues).
2. Integration tests against ephemeral MySQL + Redis (e.g. testcontainers) to
   cover the resume budget/cascade and the reaper end-to-end, not just the
   unit-level paths.
3. Build the Mailbox Quota UI with the polling strategy described above.
4. Load-balance sends across a user's mailboxes instead of always the lowest id.

---

## Verification status
- `npm run typecheck` → passes (exit 0).
- `npm test` → 20 passing (rate limiter against real Redis + worker concurrency
  + pure budget-allocator unit tests).
- **End-to-end run performed** against live MySQL 8.0.46 + Redis on this host:
  - `npm run setup:db` applied schema + seed and enqueued 3 jobs.
  - Login as alice → list sequences (2) → sequence detail (3 steps, 3 prospects).
  - Worker dispatched all 3 seeded emails (`status='sent'`); quota endpoint
    reported `daily/hourly used = 3`, then `6` after a second sequence's first
    step — i.e. the rate limiter counted exactly.
  - Pause: cancelled the future (delayed) jobs and was idempotent
    (`alreadyPaused`). Resume: rescheduled all pending rows from now with the
    per-step cascade (step 2 landed at now + 3 days) and was idempotent
    (`alreadyActive`).
  - **Two bugs were discovered only by running it** and are now fixed + logged in
    FINDINGS: (1) the UTC/session-timezone mismatch that stranded every job in the
    delayed set, and (2) the schedule-before-activate race that stranded delay-0
    first-step emails as `pending`.
