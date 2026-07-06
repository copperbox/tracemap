# Sandcastle workflow

An autonomous loop that turns open GitHub issues into reviewed, version-bumped
**pull requests** for a human to merge. It never merges to `main` itself.

Issues are grouped into **features** (cohesive units that ship as one PR). Each
feature is built on its own branch, reviewed, integrated, given a semver bump,
and delivered as a draft PR that flips to *ready for review* once all its issues
land. Features run as independent concurrent pipelines, so one feature waiting on
your review never blocks another.

Entry point: `npx tsx .sandcastle/main.mts` (aliased as `npm run sandcastle`).
Run it forever with `scripts/sandcastle-loop.sh`.

---

## The one idea that makes it safe

**All durable state lives in git + GitHub. There is no local state file.** Every
step is re-runnable, because the truth is always re-read from:

| Fact | Source of truth |
|---|---|
| Which issues are queued | open issues with the `Sandcastle` label, minus `sandcastle:in-review` |
| Feature identity + fixed membership | a JSON marker in the feature PR body |
| Which issues are done | `sandcastle:in-review` label / closed state |
| Integrated code | commits on `sandcastle/feature-*` (pushed to origin) |
| Per-issue work | commits on `sandcastle/issue-{id}` |
| Version already bumped? | a `chore(release):` commit on the feature branch |
| Blocking graph | **nowhere** — recomputed by the planner every cycle |

A killed process loses nothing: the next run re-derives everything. See
[Crash recovery](#crash-recovery).

---

## Branch topology

```
main                                  synced from origin at the top of each cycle
 └─ sandcastle/feature-<slug>         integration branch, cut off main
     ├─ sandcastle/issue-<id>         cut off the feature branch (baseBranch)
     └─ sandcastle/issue-<id>
   → merge issue branches → feature branch
   → chore(release): vX.Y.Z           semver bump commit
   → push, open/refresh PR → main
```

Issue branch names are `sandcastle/issue-{id}` — **deterministic and
independent of feature grouping**, so an issue's work is always locatable even
if grouping changes. Issue branches are cut off the *feature* branch tip, so a
later round's issue automatically builds on earlier merged work (this is how
in-feature blocking order is honored — see [Ordering](#ordering--conflicts)).

---

## The cycle

The outer loop runs up to `MAX_ITERATIONS` times. Each iteration:

### Phase 0 — Sync + reconcile + re-bump (host only, no sandboxes)
1. **`syncMainFromOrigin()`** — `git fetch` + fast-forward local `main` to
   `origin/main` so every downstream computation reflects what is actually
   merged. Fast-forward only; a diverged/ahead local `main` is left untouched
   with a warning (the orchestrator never commits to `main`).
2. **`ensureInReviewLabel()`** — create `sandcastle:in-review` if missing.
3. **Reconcile** — any issue labelled in-review whose feature PR is no longer
   open (you closed it unmerged) has the label removed, so it re-enters the
   queue.
4. **Auto re-bump** — any ready feature PR whose version no longer exceeds
   `main` (a sibling merged and took that version) is refreshed against `main`
   and re-bumped. See [Version bumps](#version-bumps).

If there are no queued issues, exit **3** (idle — see [Exit codes](#exit-codes)).

### Phase 1 — Plan (one opus agent, on `main`)
The planner groups the queued issues into features, **respecting the fixed
membership of features that already have an open PR**, and marks each issue
`workNow: true/false` (unblocked vs blocked). It biases toward sequencing: when
unsure whether two issues overlap, it marks one blocked so they run in separate
rounds. Output is validated against a schema (`<plan>` JSON). If nothing is
workable, exit **3**.

### Phase 2 — Deliver (one concurrent pipeline per feature)
For each feature, independently (`runFeature`):
1. `ensureFeatureBranch` off `main`.
2. Implement + review each **workable, not-yet-done** issue concurrently, each
   in its own sandbox cut off the feature branch.
3. **Integrate** — merge the issue branches that carry new work onto the feature
   branch (`merge-prompt.md`: resolve conflicts, run tests), then push.
4. **Finalize** (`finalizeFeaturePR`):
   - Not all members done → create/update a **draft** PR (checklist of progress).
   - All members done → bump the version + write the description
     (`release-prompt.md`), push, update the PR, and flip it **ready**.
5. **Label** newly-integrated issues `sandcastle:in-review` (done *last* — see
   [Crash recovery](#crash-recovery)).

Delivery to `main` is your manual PR merge. `Closes #…` lines in the PR body
auto-close the issues when you merge.

---

## Version bumps

Every feature PR carries a semver bump of the **root `package.json`** (the app
version; `web/` and `server/` are left alone):

- **patch** — bug fixes / internal changes, no functional change
- **minor** — new backward-compatible functionality
- **major** — a breaking change

The `release-prompt.md` agent judges the level from the whole feature diff
(highest wins) and commits `chore(release): vX.Y.Z (<level>)`.

**Idempotent** — the bump is guarded on that commit's presence
(`hasReleaseCommit`), so a re-run never double-bumps.

**Collision handling (automatic)** — two PRs open concurrently both bump from
the same base (e.g. both `0.1.0 → 0.2.0`). When you merge the first, Phase 0's
auto re-bump detects that the other's version no longer exceeds `main` and
refreshes it against `main`, re-bumping one level higher (`0.2.0 → 0.3.0`) via
`rebump-prompt.md`. If two siblings both need it in one cycle they both land on
`0.3.0` (colliding only with each other, not `main`); merging one then triggers
the other to `0.4.0`. So versions are allocated in the order you actually merge.

---

## Ordering & conflicts

- **Blocking order** is honored across rounds: a blocked issue waits, and when it
  runs a later round its branch is cut off the feature branch that now contains
  its blocker's merged code.
- **Same-round issues** run concurrently and don't see each other until
  integration. The planner is told to sequence anything that might overlap; if
  overlap slips through, the merge agent resolves the conflict and re-runs tests
  during integration. A genuinely missed dependency surfaces as a test failure
  the merge agent fixes.

---

## Crash recovery

Nothing needs a clean shutdown. The key invariant: **an issue is labelled
in-review only *after* its feature PR is fully finalized**, and done-detection
uses git integration state (not just labels). So:

- Killed after merging but before labelling → next run re-derives integration
  from git, the unlabelled issue keeps the feature in the queue, and it
  self-heals through the normal path (no duplicate work — re-implementing a
  finished branch is a no-op, re-integrating is skipped).
- Killed after "ready" but before labelling → the feature is requeued and
  re-finalized; the bump is skipped (release commit already present) and
  `markReady` is a no-op.
- Bump agent fails on the final round → `finalizeFeaturePR` returns not-ready,
  the PR stays a draft, **no labels are applied**, and the feature retries next
  cycle.

Recovery needs no separate reconciliation pass — it falls out of "unlabelled →
requeued."

---

## Exit codes

`main.mts` exits with:

- **0** — reached `MAX_ITERATIONS` (there may be more to do; loop re-runs).
- **1** — a crash / unhandled error.
- **3** — idle: nothing queued or everything remaining is blocked/in-review.

`scripts/sandcastle-loop.sh` re-runs on **0**, stops cleanly on **3**, and
propagates any other non-zero as a failure. Because collisions and new work are
only detected while the loop is running, restart the loop after you merge a PR if
it has already idle-stopped.

---

## Files

| File | Role |
|---|---|
| `main.mts` | Orchestration loop (all phases). |
| `check-tasks.mts` | Host issue queries: `checkTasks`, `getInReviewIssueNumbers`. |
| `feature-pr.mts` | Host git/gh helpers: branches, push, PR create/edit/ready, labels, the PR-body marker, version reads, collision detection, `syncMainFromOrigin`. |
| `plan-prompt.md` | Planner: group into features, `workNow` flags, sequencing bias. |
| `implement-prompt.md` | Implementer (RGR loop) for one issue. |
| `review-prompt.md` | Per-issue reviewer. |
| `merge-prompt.md` | Merge issue branches onto the feature branch. |
| `release-prompt.md` | Version bump + PR description when a feature is complete. |
| `rebump-prompt.md` | Merge latest `main` + re-bump a collided PR. |
| `tsconfig.json` | Type-check config for the `.mts` scripts. |
| `../scripts/sandcastle-loop.sh` | Re-run `npm run sandcastle` until idle. |

---

## Configuration

In `main.mts`:

- `MAX_ITERATIONS` — plan→deliver cycles per invocation.
- `IDLE_EXIT_CODE` (3) — must match `scripts/sandcastle-loop.sh`.
- `AGENT_MODEL` — the model used for every agent.
- `hooks` / `copyToWorktree` — sandbox bootstrapping.

In `feature-pr.mts`:

- `TARGET_BRANCH` (`main`) — base branch for features, PRs, and version reads.
- `FEATURE_BRANCH_PREFIX` / `ISSUE_BRANCH_PREFIX` — branch naming.

---

## Operational requirements

- **`gh` authenticated** on the host with push access to `origin` (used for all
  branch pushes, PRs, labels, and issue queries — never inside a sandbox).
- **Docker** available for sandboxes.
- The repo's base branch is **`main`**; PRs target it.
- Run the loop from a **clean checkout on `main`**. `syncMainFromOrigin`
  fast-forwards local `main` each cycle; if you have unpushed local commits on
  `main` it will warn and skip rather than touch them.
- The `sandcastle:in-review` label is created automatically on first run.
