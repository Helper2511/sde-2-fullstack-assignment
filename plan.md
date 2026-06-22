# Plan — SDE-2 Full Stack Take-Home (Backend only)

> **Status:** COMPLETE. End-to-end verified against live MySQL 8 + Redis (login →
> list → worker dispatch → pause/resume). Tests pass (13), typecheck passes, all
> deliverable docs written. The live run surfaced and fixed two further bugs
> (UTC/session-timezone mismatch; schedule-before-activate race).
> See `REVIEW.md` for the full current-state audit this plan is derived from.
>
> **Scope decision:** backend-only. No `frontend/` exists; Task 4's Mailbox
> Quota **UI** is intentionally skipped (justified in `DECISIONS.md`). The quota
> **backend** endpoint is reviewed/hardened.

---

## 0. Deliverables (what the assignment grades)

- [x] Branch off `main` (`jinishmodi_sde2-submission`).
- [x] **Tests** — rate limiter + worker atomic-claim concurrency path (13 passing).
- [x] `FINDINGS.md` — one entry per bug (14 entries).
- [x] `DECISIONS.md` — pause/resume + in-flight + quota + skipped-frontend +
      send-failure trade-offs; "with another day"; consciously-not-fixed.
- [x] `AI_USAGE.md` — tools, 2 good prompts, 3 times AI was wrong + the catch.
- [x] Atomic, well-messaged commits.

---

## 1. Get it running (Task 1) — ✅ done (code)

- [x] `backend/scripts/setup-db.ts` (apply schema → seed → enqueue pending).
- [x] `backend/src/db/seed.sql` (alice 3 mailboxes / 2 sequences, seq 1 active +
      3 prospects pre-scheduled `NOW()`; bob 1 mailbox; real bcrypt hash).
- [x] **Ran end-to-end** against live MySQL 8.0.46 + Redis: login → list →
      worker dispatched all 3 seeded emails → quota correct → pause/resume.
      Surfaced two timing/timezone bugs (now fixed; see FINDINGS).

---

## 2. Find & fix bugs (Task 2) — ✅ done (code)

All 13 issues are fixed in the working tree (full table in `REVIEW.md`).
Headline fixes:

1. Scheduler loop off-by-one + non-cumulative delay — `scheduler.ts`.
2. `computeNextSendTime` missing `*1000` — `service.ts`.
3. Rate limiter `>=` boundary **and atomic Lua** check+increment — `rateLimiter.ts`.
4. Worker **atomic row claim** (`pending`→`processing`) — kills double-send and
   double-quota-consume — `processor.ts`.
5. Log 'sent' only after `send()` succeeds — `processor.ts`.
6. Pure `readQuota` (no no-TTL key leak) — `rateLimiter.ts`.
7. Schedule idempotency guard — `scheduler.ts`.
8. JWT prod fail-fast — `env.ts`.
9. **IDOR** fix on `GET /scheduled-emails/:id` — `routes.ts`.
10. Rate-limited job re-enqueue; attempts not counted on bounce — `processor.ts`.

- [ ] Transcribe these into `FINDINGS.md` in the required format (file:line,
      severity, what's wrong, when it manifests, fix, how verified).

---

## 3. Pause / Resume (Task 3) — ✅ done (code)

- [x] **Pause:** status→paused (idempotent); `cancelDelayedJobs` for not-yet-due
      jobs; worker re-checks `sequence_status` and leaves in-flight rows
      `pending` so resume can re-schedule them.
- [x] **Resume:** (idempotent) cascade from `now + delay_days`, later steps
      cascade by their own delay; per-mailbox remaining daily/hourly budget
      respected with overflow rolling to the next window; deterministic
      `se-<id>` re-enqueue (remove-then-add) to avoid double-queue.
- [ ] Capture trade-offs in `DECISIONS.md` (in-flight handling, budget spillover,
      `processing`-stuck rows, terminal send-failure).

---

## 4. Quota backend (Task 4 — backend only) — ✅ done (code)

- [x] `GET /mailboxes/:id/quota` ownership-checked; `readQuota` hardened.
- [ ] Document the skipped UI + chosen-refresh-strategy reasoning (what the UI
      *would* have done) in `DECISIONS.md`.

---

## 5. Tests (Task 5) — ✅ done (13 passing)

- [x] **vitest** added (`npm test` / `npm run test:watch`); documented in
      `DECISIONS.md`.
- [x] **Rate limiter** (`tests/rateLimiter.test.ts`, real Redis + mocked DB):
      exact-limit boundary, daily vs hourly, daily-before-hourly reason,
      unknown mailbox, TTL set on keys, pure `readQuota`, and **100 parallel
      `checkAndIncrement` ≤ limit** (the TOCTOU headline test).
- [x] **Worker atomic claim** (`tests/processor.concurrency.test.ts`): two jobs
      race one row → exactly one send + one quota consume; plus pause guard,
      unsubscribed-skip, and rate-limit re-enqueue.
- [x] Suite auto-skips rate-limiter tests if Redis is unreachable.

---

## 6. Execution order (remaining)

1. Tests (rate limiter, then atomic-claim/resume).
2. `FINDINGS.md`, `DECISIONS.md`, `AI_USAGE.md`.
3. One end-to-end smoke run; record notes.
4. Atomic commits grouped by area (setup, scheduler, rate limiter, worker,
   auth/env, resume, tests, docs).
5. Optional cleanups: drop dead `_typeBrand()`; revisit `cancelDelayedJobs`
   N+1/5000-cap if time allows.

---

## 7. Post-review hardening (done)

A self-review of the diff surfaced robustness gaps, all now fixed and verified
(typecheck + 20 tests + live e2e). See `DECISIONS.md` → "Post-review hardening".

- [x] `asyncHandler` wrapping every route (Express 4 doesn't await async handlers).
- [x] Unified schedule/resume budget logic (shared `nextAvailableSlot` +
      `createBudgetTracker`); initial schedule now spreads across windows.
- [x] `processing`-stuck reaper + `claimed_at` column (worker runs it every 60s).
- [x] `cancelDelayedJobs` filters on job `sequenceId` (no N+1, no 5000 cap).
- [x] CORS allowlist + Redis-backed `/auth/login` brute-force throttle.
- [x] Added pure budget-allocator unit tests; removed dead `_typeBrand()`.

---

## Assumptions (carry into DECISIONS.md)

- `delay_days` on resume measured **from now** for the first remaining step per
  prospect, then cascading by each later step's delay.
- Budget overflow on resume **rolls forward** to the next window rather than
  being dropped.
- Genuine `send()` failure is currently **terminal** (no BullMQ retry config);
  acceptable for the take-home — call it out explicitly.
- Frontend skipped by direction → Task 4 UI and its tests intentionally omitted.
</content>
