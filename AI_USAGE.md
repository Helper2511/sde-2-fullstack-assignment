# AI_USAGE

## Tools

- **Claude (Claude Code)** — primary assistant for the whole task: reading the
  codebase, hunting bugs, drafting the rate-limiter Lua script and the resume
  logic, and scaffolding the vitest suite.
- I treated AI output as a **draft to be reviewed**, not as ground truth — every
  suggested fix was checked against the actual code and, where possible, a test.

---

## Prompts that worked well

**1. Concurrency-focused bug hunt.**
> "Read `processor.ts` and `rateLimiter.ts`. The worker runs with concurrency 4.
> Walk through what happens when two jobs for the same mailbox, near its limit,
> run at the same time. Where exactly is the race?"

This pinned the TOCTOU race in `checkAndIncrement` (GET → compare → INCR across
separate round-trips) and led to the single-Lua-script fix. Framing it as
"two jobs at the same time, step through it" was far more productive than
"find bugs," which produces a shallow checklist.

**2. Designing the resume budget logic.**
> "Resume must reschedule pending emails so that (a) delays are measured from now
> and cascade per step, and (b) we never queue more sends into a window than the
> mailbox's remaining daily/hourly budget. Overflow should roll to the next
> window. Sketch the algorithm and the edge cases."

This produced the per-mailbox budget tracker (remaining-now for the current
window, full limit for future windows) and surfaced edge cases I then handled:
zero remaining budget, prospect bucketing, and idempotent re-enqueue by jobId.

---

## When AI led me astray (and how I caught it)

**1. `skipIf` evaluated at the wrong time — silent green that was actually skipped.**
The first version of the rate-limiter test probed Redis inside a `beforeAll` hook
and gated the suite with `describe.skipIf(!redisUp)`. It looked correct and the
run was green — but the output said **"8 skipped."** vitest evaluates `skipIf` at
*collection* time, before any hook runs, so `redisUp` was always still `false` and
every test silently skipped. A passing-but-skipped suite is worse than a failing
one because it hides that nothing ran. The fix was to move the Redis probe to a
**top-level await** (with a timeout) so `skipIf` sees real connectivity. Caught by
actually reading the test summary line instead of trusting the green checkmark.

**2. A plausible "cleanup" that broke the build.**
While tidying config, AI suggested re-adding `"scripts/**/*"` to the tsconfig
`include` "for full coverage." That sounds right, but `rootDir` is `"src"`, so
`tsc -p .` immediately failed with TS6059 ("not under rootDir"). The previous
engineer had removed it for exactly this reason. I reverted, and confirmed the
original removal was the correct call. Caught by running `npm run typecheck`
rather than assuming the suggestion was safe.

**3. `.catch()` on a non-promise (caught by running it).**
While hardening `db.ts`, AI wrote `conn.query("SET time_zone='+00:00'").catch(() => {})`
in the pool's `connection` handler. It looks fine and even typechecked, but at
runtime mysql2 hands that event the *core* (callback-style) connection whose
`.query()` returns an emitter, not a promise — so `.catch` is undefined and the
worker crashed on startup with mysql2's "not a promise" error. Caught by actually
starting the worker and reading the log, not by trusting the green typecheck. Fix:
use the callback form `conn.query(sql, () => {})` (with a cast, since the types
wrongly claim it's a promise connection).

**4. Scope assumption worth flagging.**
Early on AI was ready to proceed as "backend only" and even drafted a plan that
asserted the frontend "does not exist, therefore out of scope." That's a
*decision*, not a fact to assume — the assignment grades the Quota UI. I made the
skip an explicit, justified decision (see `DECISIONS.md`) rather than letting it
slip through silently.

---

## Net assessment

AI was strongest at stepping through concurrency scenarios and generating the
first draft of mechanical code (Lua, test scaffolding). It was weakest at
*verification discipline* — it would declare success on a green run that was
actually skipped, and propose tidy-looking config changes that didn't compile.
The value I added was insisting on a concrete check (read the skip count, run the
typecheck, run the test that targets the exact race) for every claim.
