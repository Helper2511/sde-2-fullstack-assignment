# Code Review — Current State vs. ASSIGNMENT.md

> Snapshot date: 2026-06-22. Branch: `jinishmodi_sde2-submission`.
> This is an audit of what is **actually in the working tree right now**, mapped
> to each assignment task. It is the source of truth that `plan.md` is derived
> from. All backend changes below are currently **uncommitted** (see `git status`).

---

## Scope decision (confirmed)

**Backend-only.** No `frontend/` directory exists in the repo. The root
`package.json` declares a `frontend` workspace and the README/assignment
reference `frontend/src/pages/MailboxQuota.tsx` (Vite, port 5173), but the
previous engineer never committed it. Per direction, **Task 4's UI is
intentionally skipped** and justified in `DECISIONS.md`; the quota **backend**
(`GET /mailboxes/:id/quota`) is still reviewed and hardened.

---

## Task-by-task status

| Task | Status | Notes |
|------|--------|-------|
| 1. Get it running | ✅ Done (code) | `setup-db.ts` + `seed.sql` created; seed matches README. Not runtime-verified here (needs local MySQL 8 + Redis 6). |
| 2. Find & fix bugs | ✅ Done (code) | All identified issues fixed in working tree. See table below. |
| 3. Pause / Resume | ✅ Done (code) | Pause guard in worker + cancel delayed jobs; resume cascades from now + respects per-mailbox budget. |
| 4. Mailbox Quota UI | ⚠️ Skipped | No frontend. Backend endpoint hardened. Documented in `DECISIONS.md`. |
| 5. Tests | ❌ **Not started** | No framework, no test files. **Required.** |
| `FINDINGS.md` | ❌ **Missing** | Required deliverable. |
| `DECISIONS.md` | ❌ **Missing** | Required deliverable. |
| `AI_USAGE.md` | ❌ **Missing** | Required deliverable. |

---

## Task 1 — Get it running

- `backend/scripts/setup-db.ts` — creates DB, applies `schema.sql` then
  `seed.sql`, then enqueues a BullMQ job for every `pending` scheduled_email
  (best-effort if Redis is down). Uses `timezone: 'Z'`.
- `backend/src/db/seed.sql` — alice (3 mailboxes, 2 sequences), bob (1 mailbox,
  no sequences); seq 1 = `active` with 3 prospects pre-scheduled at `NOW()`;
  bcrypt hash is a real `password123` hash. Matches the README table.
- Pool (`config/db.ts`) uses `timezone: 'Z'`, consistent with the UTC
  day/hour keys in the rate limiter and scheduler — no TZ skew between writes
  and window bucketing.

**Not done:** an actual end-to-end smoke run (login → list → watch worker)
against live MySQL/Redis. Should be performed before submission and any
"broken-before-touching" notes captured.

---

## Task 2 — Bugs fixed (verified present in code)

| # | Bug | File | Fix in place |
|---|-----|------|--------------|
| 1 | Scheduler loop skipped step[0], read steps[length] | `scheduler.ts:62` | `for (i=0; i<steps.length; i++)` ✓ |
| 2 | Per-step delay not cumulative | `scheduler.ts:61-66` | running `offsetMs` cascade ✓ |
| 3 | `computeNextSendTime` missing `*1000` (1000× short) | `service.ts:87` | converts days→ms ✓ |
| 4 | Rate-limit boundary off-by-one (`>` allowed limit+1) | `rateLimiter.ts:58-59` | `>=` ✓ |
| 5 | **Check+increment not atomic** (TOCTOU under concurrency=4) | `rateLimiter.ts:55-65` | single Lua script ✓ (headline fix) |
| 6 | `send_logs` logged 'sent' before send() | `processor.ts:138-145` | log after successful send ✓ |
| 7 | Quota consumed / double-send on retry | `processor.ts:86-92` | atomic conditional UPDATE claim (`pending`→`processing`) ✓ |
| 8 | `readQuota` wrote `SET key 0` (no-TTL key leak) | `rateLimiter.ts:107-108` | pure read, missing=0 ✓ |
| 9 | `attempts` incremented on rate-limit bounce | `processor.ts:94-126` | incremented only on real attempt ✓ |
| 10 | Re-schedule duplicates rows/jobs | `scheduler.ts:42-46` | DISTINCT prospect_id idempotency guard ✓ |
| 11 | JWT hardcoded dev-secret fallback | `env.ts:11-13` | fail-fast in production ✓ |
| 12 | **IDOR**: any user could read any scheduled_email by id | `routes.ts:111-127` | join sequence + filter `user_id` ✓ |
| 13 | Rate-limited job never re-enqueued (stuck pending) | `processor.ts:101-119` | release + delayed re-enqueue ✓ |

**Atomic claim is the keystone.** `processSendJob` now does a conditional
`UPDATE ... SET status='processing' WHERE id=? AND status='pending'`; only the
winner proceeds, so even if resume + a rate-limit retry both point a job at the
same row, exactly one consumes quota and sends. This is what makes #7 a real
fix rather than a symptom patch.

---

## Task 3 — Pause / Resume

**Pause** (`routes.ts:87-95`, `processor.ts:67-78`, `scheduler.ts:268-284`)
- Sets status `paused`; idempotent no-op if already paused.
- `cancelDelayedJobs` removes not-yet-due delayed jobs for the sequence.
- Worker re-checks `sequence_status` after loading the row; if not `active`,
  it logs `paused` and **leaves the row `pending`** (so resume can pick it up).
  This is the "respect pause ASAP" guard for jobs already promoted to
  waiting/active that `cancelDelayedJobs` can't reach.

**Resume** (`routes.ts:97-105`, `scheduler.ts:160-250`)
- Idempotent no-op if not paused.
- Selects `pending` rows ordered by prospect, then step_order.
- Cascade: first remaining step per prospect fires at `now + delay_days`,
  later steps cascade by their own delay via corrected `computeNextSendTime`.
- Per-mailbox budget: current window uses *remaining* budget, future windows
  the full limit; overflow rolls to the next hour/day (guard-bounded loop).
- Re-enqueues under deterministic `se-<id>` jobId after `remove()` of any
  stale job, so a double-resume can't double-queue.

---

## Task 4 — Quota (backend only)

- `GET /mailboxes/:id/quota` checks ownership, returns
  `{ mailboxId, email, daily:{used,limit}, hourly:{used,limit} }`.
- `readQuota` hardened to a pure read (issue #8).
- No UI (scope decision). The endpoint shape already supports the planned UI
  (per-mailbox used/limit for daily & hourly + an ≥80% threshold client-side).

---

## Task 5 — Tests (OUTSTANDING — required)

Nothing exists yet. Needed:
- Pick framework (recommend **vitest**) and add to `backend/package.json`;
  document in `DECISIONS.md`.
- **Rate limiter:** boundary at exactly the limit (covers #4), daily vs hourly,
  and **N concurrent `checkAndIncrement` never exceed the limit** (covers #5).
- **One more concurrency path:** either the worker atomic claim (two jobs, one
  row → exactly one send / one quota consume — covers #7), or resume budget-cap
  correctness.
- Use ioredis-mock / ephemeral Redis and a mocked/isolated DB.

---

## Additional observations (to confirm / document, not necessarily fix)

- **Genuine SMTP send failure is terminal.** On `send()` throw, the row goes to
  `failed` and the error rethrows, but jobs are added with no BullMQ retry
  config, so the 5% simulated failures are dropped (not retried). Decide & note:
  acceptable for the take-home, or add bounded retries. → `DECISIONS.md`.
- **`processing`-stuck rows.** If the worker crashes mid-job, a row can stay
  `processing`; resume only re-schedules `pending` rows, so it won't recover
  these. Known limitation → `DECISIONS.md`.
- **`cancelDelayedJobs`** still does an N+1 lookup and caps at 5000 delayed
  jobs; jobs already in waiting/active aren't cancelled (the worker pause guard
  covers those). Acceptable; document.
- **`_typeBrand()` in `scheduler.ts:286`** is dead code kept only to retain the
  `Step` import — candidate for cleanup.
- **All work is uncommitted.** Needs atomic, well-messaged commits grouped by
  area (setup, scheduler, rate limiter, worker, auth, resume, tests, docs).

---

## Critical path to "submittable"

1. Add tests (rate limiter + one concurrency path) — **Task 5**.
2. Write `FINDINGS.md` (13 issues above), `DECISIONS.md` (pause/resume +
   in-flight + quota + skipped-frontend + send-failure trade-offs), `AI_USAGE.md`.
3. Run the app end-to-end once; capture any runtime notes.
4. Commit in atomic chunks with meaningful messages.
</content>
</invoke>
