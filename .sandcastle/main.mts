// Parallel Feature Planner with Review + PR delivery -- multi-phase loop.
//
// This template drives an autonomous workflow that groups issues into features,
// implements them on isolated branches, integrates each feature onto its own
// feature branch, and delivers finished work as a GitHub pull request for a
// human to review and merge -- it never merges to `main` itself.
//
//   Phase 0 (Check):   On the HOST, reconcile in-review issues whose PR was
//                      closed unmerged, then fetch the open Sandcastle issues
//                      that are not already parked behind a feature PR.
//   Phase 1 (Plan):    An opus agent groups the open issues into features
//                      (cohesive units that ship as one PR), respecting the
//                      membership of features that already have an open PR, and
//                      marks which issues are workable now vs. blocked.
//   Phase 2 (Deliver): Each feature runs as an INDEPENDENT, concurrent pipeline:
//                      implement + review each workable issue on its own branch
//                      (cut off the feature branch), integrate the completed
//                      issue branches onto the feature branch, push, and open or
//                      update a DRAFT PR. Each completed issue is labelled
//                      in-review so it leaves the queue. When every member issue
//                      of a feature is done, the draft PR is fleshed out with a
//                      generated description and flipped to ready-for-review.
//
// Crucially there is NO global merge barrier: one feature waiting on human
// review never blocks another feature's issues from being worked or shipped.
//
// The outer loop repeats up to MAX_ITERATIONS times so newly unblocked issues
// (including ones unblocked by an earlier merge onto their feature branch) are
// picked up on later rounds.
//
// Usage:
//   npx tsx .sandcastle/main.mts
// Or add to package.json:
//   "scripts": { "sandcastle": "npx tsx .sandcastle/main.mts" }

import { exit } from "node:process";
import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { z } from "zod";
import { checkTasks, getInReviewIssueNumbers } from "./check-tasks.mts";
import {
  TARGET_BRANCH,
  type FeatureMember,
  type FeaturePR,
  addInReview,
  buildFeatureBody,
  commitsAhead,
  createDraftPR,
  effectiveDoneIds,
  ensureFeatureBranch,
  ensureInReviewLabel,
  findFeaturePR,
  getFeatureDoneIds,
  getOpenFeaturePRs,
  hasReleaseCommit,
  isIssueIntegrated,
  issueBranch,
  markReady,
  needsRebump,
  pushBranch,
  readReleaseLevel,
  readVersion,
  removeInReview,
  removeLeakedWorktree,
  setPRBody,
  syncMainFromOrigin,
} from "./feature-pr.mts";

// The planner emits its plan as JSON inside <plan> tags; Output.object extracts
// and validates it against this schema. Each feature carries its full member
// list (workNow flags which issues are unblocked this round) so the workflow
// knows both what to do now and when the feature is complete.
const planSchema = z.object({
  features: z.array(
    z.object({
      slug: z.string(),
      branch: z.string(),
      title: z.string(),
      issues: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          branch: z.string(),
          workNow: z.boolean(),
        }),
      ),
    }),
  ),
});

type PlanFeature = z.infer<typeof planSchema>["features"][number];
type PlanIssue = PlanFeature["issues"][number];

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Maximum number of plan -> deliver cycles before stopping.
// Raise this if your backlog is large; lower it for a quick smoke-test run.
const MAX_ITERATIONS = 10;

// Exit code used when there is no work to do (no Sandcastle-labelled issues, or
// every open issue is blocked/in-review). Distinct from 0 (worked through the
// backlog cleanly) and 1 (a crash/thrown error) so a supervising loop -- e.g.
// scripts/sandcastle-loop.sh -- can tell "idle, stop polling" apart from both a
// normal completion and a real failure.
const IDLE_EXIT_CODE = 3;

// Per-role model + reasoning effort. Fable 5 writes and reviews the code; Opus
// 4.8 handles the reasoning-heavy planning and the conflict-resolving merges;
// Sonnet 5 (cheaper) handles the packaging steps. Effort is capped at "high"
// (never xhigh/max) for cost, and dropped to medium/low on the simpler steps.
const AGENTS = {
  planner: { model: "claude-opus-4-8", effort: "high" },
  implementer: { model: "claude-fable-5", effort: "high" },
  reviewer: { model: "claude-fable-5", effort: "medium" },
  merger: { model: "claude-opus-4-8", effort: "medium" },
  refresh: { model: "claude-opus-4-8", effort: "medium" },
  rebump: { model: "claude-sonnet-5", effort: "medium" },
  release: { model: "claude-sonnet-5", effort: "low" },
} as const;

// The agent provider (model + effort) for a given role.
function agentFor(role: keyof typeof AGENTS): sandcastle.AgentProvider {
  const { model, effort } = AGENTS[role];
  return sandcastle.claudeCode(model, { effort });
}

// Hooks run inside the sandbox before the agent starts each iteration.
// npm install ensures the sandbox always has fresh dependencies.
const hooks = {
  sandbox: { onSandboxReady: [{ command: "npm install" }] },
};

// Copy node_modules from the host into the worktree before each sandbox starts.
// Avoids a full npm install from scratch; the hook above handles
// platform-specific binaries and any packages added since the last copy.
const copyToWorktree = ["node_modules"];

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Count the commits an issue branch carries that its feature branch does not yet
// have. Runs inside the issue's sandbox, where `exec` defaults its cwd to the
// worktree repo. Used only to gate the reviewer (don't review a no-op run).
async function branchCommitsAhead(
  sandbox: sandcastle.Sandbox,
  base: string,
  branch: string,
): Promise<{ sha: string }[]> {
  const res = await sandbox.exec(`git rev-list ${base}..${branch}`);
  if (res.exitCode !== 0) {
    throw new Error(
      `git rev-list ${base}..${branch} failed (exit ${res.exitCode}): ${res.stderr.trim()}`,
    );
  }
  return res.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((sha) => ({ sha }));
}

// Run `fn` against a short-lived sandbox checked out on the given branch.
async function withFeatureSandbox<T>(
  branch: string,
  fn: (sandbox: sandcastle.Sandbox) => Promise<T>,
): Promise<T> {
  await removeLeakedWorktree(branch);
  const sandbox = await sandcastle.createSandbox({
    branch,
    sandbox: docker(),
    hooks,
    copyToWorktree,
  });
  try {
    return await fn(sandbox);
  } finally {
    await sandbox.close();
  }
}

// Implement and (if it produced commits) review a single issue on its own
// branch, cut off the feature branch. Best-effort: git state is the source of
// truth for what actually landed, so we don't return a status here.
async function implementAndReview(
  feature: PlanFeature,
  issue: PlanIssue,
): Promise<void> {
  const branch = issueBranch(issue.id);
  await removeLeakedWorktree(branch);
  const sandbox = await sandcastle.createSandbox({
    branch,
    baseBranch: feature.branch,
    sandbox: docker(),
    hooks,
    copyToWorktree,
  });
  try {
    const implement = await sandbox.run({
      name: `implementer:${issue.id}`,
      maxIterations: 100,
      agent: agentFor("implementer"),
      promptFile: "./.sandcastle/implement-prompt.md",
      promptArgs: {
        TASK_ID: issue.id,
        ISSUE_TITLE: issue.title,
        BRANCH: branch,
      },
    });

    if (implement.completionSignal === undefined) {
      console.warn(
        `  ⚠ ${issue.id} implementer stopped without a completion signal (iteration cap or context limit).`,
      );
    }

    const ahead = await branchCommitsAhead(sandbox, feature.branch, branch);
    if (ahead.length === 0) return;

    // A reviewer failure must never discard committed work: log and move on.
    try {
      await sandbox.run({
        name: `reviewer:${issue.id}`,
        maxIterations: 1,
        agent: agentFor("reviewer"),
        promptFile: "./.sandcastle/review-prompt.md",
        promptArgs: { BRANCH: branch },
      });
    } catch (err) {
      console.error(
        `  ⚠ reviewer failed on ${branch}: ${errMsg(err)}. Keeping committed work.`,
      );
    }
  } finally {
    await sandbox.close();
  }
}

// Prepare the release for a completed feature: idempotently bump the root
// package.json version on the feature branch (skipped when a release commit
// already exists) and generate the PR description. Returns the chosen bump
// level and description; both may be null on agent failure.
async function prepareRelease(
  feature: PlanFeature,
  members: FeatureMember[],
  alreadyBumped: boolean,
): Promise<{ level: string | null; description: string | null }> {
  try {
    return await withFeatureSandbox(feature.branch, async (sandbox) => {
      const res = await sandbox.run({
        name: `release:${feature.slug}`,
        maxIterations: 1,
        agent: agentFor("release"),
        promptFile: "./.sandcastle/release-prompt.md",
        completionSignal: "</pr-description>",
        // {{TARGET_BRANCH}} is a Sandcastle built-in (the host's active branch);
        // it is injected automatically and must not be passed here.
        promptArgs: {
          ALREADY_BUMPED: String(alreadyBumped),
          ISSUES: members.map((m) => `- #${m.id} ${m.title}`).join("\n"),
        },
      });
      const bump = res.stdout.match(/<bump>\s*(patch|minor|major)\s*<\/bump>/i);
      const desc = res.stdout.match(/<pr-description>([\s\S]*?)<\/pr-description>/);
      return {
        level: bump ? bump[1].toLowerCase() : null,
        description: desc ? desc[1].trim() : null,
      };
    });
  } catch (err) {
    console.error(
      `  ⚠ release agent failed for ${feature.slug}: ${errMsg(err)}. No bump/description this round.`,
    );
    return { level: null, description: null };
  }
}

// Create or update the feature's draft PR to reflect current progress. When
// every member issue is done, apply the version bump + description and flip the
// PR ready. Returns whether the PR is now ready-for-review -- if the bump does
// not land, readiness is deferred (PR stays a draft) so the feature retries.
async function finalizeFeaturePR(
  feature: PlanFeature,
  members: FeatureMember[],
  doneIds: Set<string>,
): Promise<{ ready: boolean }> {
  const memberIds = members.map((m) => String(m.id));
  const pr = await findFeaturePR(feature.branch);
  const branchHasWork = (await commitsAhead(TARGET_BRANCH, feature.branch)) > 0;

  // Nothing on the branch and no PR yet: nothing to publish this round.
  if (!pr && !branchHasWork) return { ready: false };

  // Create or update the PR body, returning its number.
  const publish = async (
    description: string | null,
    release: { version: string; level: string | null } | null,
  ): Promise<number> => {
    const body = buildFeatureBody({
      slug: feature.slug,
      branch: feature.branch,
      members,
      doneIds,
      description,
      release,
    });
    if (pr) {
      await setPRBody(pr.prNumber, body);
      return pr.prNumber;
    }
    await pushBranch(feature.branch); // creating a PR needs the branch on origin
    return createDraftPR({ branch: feature.branch, title: feature.title, body });
  };

  const allDone =
    memberIds.length > 0 && memberIds.every((id) => doneIds.has(id));

  if (!allDone) {
    const prNumber = await publish(null, null);
    console.log(`  · feature ${feature.slug}: draft PR #${prNumber} updated.`);
    return { ready: false };
  }

  // All members done -> bump the version (once) and write the description.
  const alreadyBumped = await hasReleaseCommit(feature.branch);
  const prep = await prepareRelease(feature, members, alreadyBumped);
  const bumped = alreadyBumped || (await hasReleaseCommit(feature.branch));

  if (!bumped) {
    // The bump did not land (agent failure). Keep the PR a draft and defer
    // readiness; the feature is retried next round.
    const prNumber = await publish(prep.description, null);
    console.warn(
      `  ⚠ feature ${feature.slug}: version bump did not land; PR #${prNumber} left as draft for retry.`,
    );
    return { ready: false };
  }

  await pushBranch(feature.branch); // push the release commit
  const release = {
    version: await readVersion(feature.branch),
    level: prep.level ?? (await readReleaseLevel(feature.branch)),
  };
  const prNumber = await publish(prep.description, release);
  await markReady(prNumber);
  console.log(
    `  ✔ feature ${feature.slug}: PR #${prNumber} ready for review (v${release.version}${
      release.level ? `, ${release.level}` : ""
    }).`,
  );
  return { ready: true };
}

// Run one feature's full pipeline. Independent of every other feature.
async function runFeature(
  feature: PlanFeature,
  existing: FeaturePR | undefined,
): Promise<void> {
  // Full, fixed membership: from the existing PR's marker if there is one, else
  // from the plan (a brand-new feature lists all its members, incl. blocked).
  const members: FeatureMember[] = existing
    ? existing.members
    : feature.issues.map((i) => ({ id: String(i.id), title: i.title }));
  const memberIds = members.map((m) => String(m.id));

  await ensureFeatureBranch(feature.branch);

  // Skip issues already done -- closed, in-review, OR already integrated into
  // the feature branch (git state is the truth) -- so we never re-do work.
  const doneAtStart = await effectiveDoneIds(memberIds, feature.branch);
  const workable = feature.issues.filter(
    (i) => i.workNow && !doneAtStart.has(String(i.id)),
  );

  if (workable.length > 0) {
    const settled = await Promise.allSettled(
      workable.map((issue) => implementAndReview(feature, issue)),
    );
    for (const [i, outcome] of settled.entries()) {
      if (outcome.status === "rejected") {
        console.error(
          `  ✗ ${workable[i]!.id} (${issueBranch(workable[i]!.id)}) failed: ${outcome.reason}`,
        );
      }
    }
  }

  // Integrate: which workable issue branches carry real work not yet on the
  // feature branch? (git state, not "did this run commit", is the truth.)
  const toMerge: PlanIssue[] = [];
  for (const issue of workable) {
    const branch = issueBranch(issue.id);
    if ((await commitsAhead(TARGET_BRANCH, branch)) === 0) continue; // missing or no work
    if ((await commitsAhead(feature.branch, branch)) > 0) toMerge.push(issue);
  }

  if (toMerge.length > 0) {
    await withFeatureSandbox(feature.branch, async (sandbox) => {
      await sandbox.run({
        name: `merger:${feature.slug}`,
        maxIterations: 1,
        agent: agentFor("merger"),
        promptFile: "./.sandcastle/merge-prompt.md",
        promptArgs: {
          FEATURE_BRANCH: feature.branch,
          BRANCHES: toMerge.map((i) => `- ${issueBranch(i.id)}`).join("\n"),
        },
      });
    });
    await pushBranch(feature.branch);
  }

  // Recompute the done set from git + labels, then finalize (bump + ready when
  // every member is done).
  const doneIds = await effectiveDoneIds(memberIds, feature.branch);
  const allDone =
    memberIds.length > 0 && memberIds.every((id) => doneIds.has(id));
  const { ready } = await finalizeFeaturePR(feature, members, doneIds);

  // Persist the in-review labels LAST. If the feature is fully done but NOT
  // confirmed ready (e.g. the version bump failed), withhold ALL labels so the
  // feature stays in the work queue and is retried next round. Otherwise label
  // every integrated member that isn't already labelled/closed so its issue
  // leaves the queue. Keeping this after finalize means a crash before "ready"
  // leaves at least one member unlabelled, which requeues the feature -- so
  // recovery needs no extra pass.
  //
  // The skip guard here is label/closed state ONLY (getFeatureDoneIds), NOT the
  // integration-aware doneAtStart: an issue integrated in an earlier round but
  // never labelled (because the release agent kept failing) must still get
  // labelled once the feature finally goes ready.
  if (allDone && !ready) {
    console.warn(
      `  ⚠ feature ${feature.slug}: not ready; leaving issues queued for retry.`,
    );
    return;
  }
  const labelledOrClosed = await getFeatureDoneIds(memberIds);
  for (const id of memberIds) {
    if (labelledOrClosed.has(id)) continue; // already in-review or closed
    if (await isIssueIntegrated(id, feature.branch)) await addInReview(id);
  }
}

// Refresh a ready feature PR whose version collided with main: merge the latest
// main into its branch and re-apply the bump (one level above the new base), so
// the PR lands a fresh version. The PR stays ready; only its branch + body move.
async function rebumpFeature(fp: FeaturePR): Promise<void> {
  const level = (await readReleaseLevel(fp.branch)) ?? "patch";
  const members = fp.members;

  let prep: { level: string | null; description: string | null } | null;
  try {
    prep = await withFeatureSandbox(fp.branch, async (sandbox) => {
      const res = await sandbox.run({
        name: `rebump:${fp.slug}`,
        maxIterations: 1,
        agent: agentFor("rebump"),
        promptFile: "./.sandcastle/rebump-prompt.md",
        completionSignal: "</pr-description>",
        // {{TARGET_BRANCH}} is a Sandcastle built-in; do not pass it here.
        promptArgs: {
          LEVEL: level,
          ISSUES: members.map((m) => `- #${m.id} ${m.title}`).join("\n"),
        },
      });
      const bump = res.stdout.match(/<bump>\s*(patch|minor|major)\s*<\/bump>/i);
      const desc = res.stdout.match(/<pr-description>([\s\S]*?)<\/pr-description>/);
      return {
        level: bump ? bump[1].toLowerCase() : null,
        description: desc ? desc[1].trim() : null,
      };
    });
  } catch (err) {
    console.error(
      `  ⚠ re-bump agent failed for ${fp.slug}: ${errMsg(err)}. Will retry next cycle.`,
    );
    return;
  }

  // Only publish if the collision is actually resolved (branch now ahead of
  // main). Otherwise leave the PR untouched and retry next cycle.
  if (await needsRebump(fp.branch)) {
    console.warn(
      `  ⚠ feature ${fp.slug}: re-bump did not resolve the version collision; will retry next cycle.`,
    );
    return;
  }

  await pushBranch(fp.branch);
  const release = {
    version: await readVersion(fp.branch),
    level: prep.level ?? level,
  };
  const body = buildFeatureBody({
    slug: fp.slug,
    branch: fp.branch,
    members,
    // A ready feature's members are all done.
    doneIds: new Set(members.map((m) => String(m.id))),
    description: prep.description,
    release,
  });
  await setPRBody(fp.prNumber, body);
  console.log(`  ↻ feature ${fp.slug}: PR #${fp.prNumber} re-bumped to v${release.version}.`);
}

// Refresh a ready feature PR that has fallen behind main (main advanced without
// taking its version, so it does not need a re-bump -- just the merge). Merges
// the latest main into the branch to keep the PR conflict-free and tested
// against current main; no version change, PR stays ready.
async function refreshFeature(fp: FeaturePR): Promise<void> {
  try {
    await withFeatureSandbox(fp.branch, async (sandbox) => {
      await sandbox.run({
        name: `refresh:${fp.slug}`,
        maxIterations: 1,
        agent: agentFor("refresh"),
        promptFile: "./.sandcastle/refresh-prompt.md",
        // {{TARGET_BRANCH}} is a Sandcastle built-in; no promptArgs needed.
      });
    });
  } catch (err) {
    console.error(
      `  ⚠ refresh agent failed for ${fp.slug}: ${errMsg(err)}. Will retry next cycle.`,
    );
    return;
  }

  // Only publish if the branch actually caught up to main.
  if ((await commitsAhead(fp.branch, TARGET_BRANCH)) > 0) {
    console.warn(
      `  ⚠ feature ${fp.slug}: still behind ${TARGET_BRANCH} after refresh; will retry next cycle.`,
    );
    return;
  }

  await pushBranch(fp.branch);
  console.log(`  ⟲ feature ${fp.slug}: PR #${fp.prNumber} refreshed with ${TARGET_BRANCH}.`);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

  // -------------------------------------------------------------------------
  // Phase 0: Sync + reconcile + re-bump (host only)
  // -------------------------------------------------------------------------

  // Track the real merged state: fast-forward local main to origin so every
  // downstream computation (new feature bases, versions, collisions) is current.
  await syncMainFromOrigin();
  await ensureInReviewLabel();

  let featurePRs = await getOpenFeaturePRs();

  // Requeue any in-review issue whose feature PR is no longer open (i.e. it was
  // closed without merging): drop the label so it re-enters the work queue.
  const inReview = await getInReviewIssueNumbers();
  if (inReview.length > 0) {
    const covered = new Set(featurePRs.flatMap((f) => f.members.map((m) => Number(m.id))));
    for (const id of inReview) {
      if (!covered.has(id)) {
        console.log(`Issue #${id} was in-review but has no open feature PR; requeuing.`);
        await removeInReview(id);
      }
    }
  }

  // Keep ready feature PRs current with main (independent per feature, so one
  // never blocks another):
  //   - version collision (a sibling merged and took the version) -> re-bump
  //     (which also merges main in);
  //   - otherwise merely behind main -> merge main in, no version change.
  // Drafts are left alone: they refresh naturally as their issues integrate.
  const refreshes = await Promise.allSettled(
    featurePRs.map(async (fp) => {
      if (await needsRebump(fp.branch)) {
        await rebumpFeature(fp);
      } else if (!fp.isDraft && (await commitsAhead(fp.branch, TARGET_BRANCH)) > 0) {
        await refreshFeature(fp);
      }
    }),
  );
  for (const [i, outcome] of refreshes.entries()) {
    if (outcome.status === "rejected") {
      console.error(`  ✗ refresh ${featurePRs[i]!.slug} failed: ${outcome.reason}`);
    }
  }

  const openIssues = await checkTasks();
  if (openIssues.length === 0) {
    console.log("No open Sandcastle-labelled issues to work on. Exiting.");
    exit(IDLE_EXIT_CODE);
  }
  console.log(`Found ${openIssues.length} Sandcastle-labelled open issue(s).`);

  // Refresh after any re-bump edits so the planner sees current PR bodies.
  featurePRs = await getOpenFeaturePRs();

  // -------------------------------------------------------------------------
  // Phase 1: Plan (opus, on main -- it only reads and reasons)
  // -------------------------------------------------------------------------
  const plan = await sandcastle.run({
    hooks,
    sandbox: docker(),
    name: "planner",
    maxIterations: 1,
    agent: agentFor("planner"),
    promptFile: "./.sandcastle/plan-prompt.md",
    promptArgs: {
      ISSUES_JSON: JSON.stringify(openIssues, null, 2),
      // Existing feature PRs (fixed membership) the planner must preserve.
      FEATURE_PRS_JSON: JSON.stringify(
        featurePRs.map((f) => ({
          slug: f.slug,
          branch: f.branch,
          issueIds: f.members.map((m) => m.id),
        })),
        null,
        2,
      ),
    },
    output: sandcastle.Output.object({ tag: "plan", schema: planSchema }),
  });

  const features = plan.output.features;
  const totalWorkable = features.reduce(
    (n, f) => n + f.issues.filter((i) => i.workNow).length,
    0,
  );

  if (totalWorkable === 0) {
    console.log(
      "No workable issues this round (everything remaining is blocked or in review). Exiting.",
    );
    exit(IDLE_EXIT_CODE);
  }

  console.log(
    `Planning complete. ${features.length} feature(s), ${totalWorkable} workable issue(s):`,
  );
  for (const f of features) {
    const now =
      f.issues.filter((i) => i.workNow).map((i) => i.id).join(", ") ||
      "(none this round)";
    console.log(`  ${f.slug} [${f.branch}] -> workable: ${now}`);
  }

  // -------------------------------------------------------------------------
  // Phase 2: Deliver -- one independent, concurrent pipeline per feature.
  // -------------------------------------------------------------------------
  const byBranch = new Map(featurePRs.map((f) => [f.branch, f]));
  const settled = await Promise.allSettled(
    features.map((f) => runFeature(f, byBranch.get(f.branch))),
  );
  for (const [i, outcome] of settled.entries()) {
    if (outcome.status === "rejected") {
      console.error(`  ✗ feature ${features[i]!.slug} failed: ${outcome.reason}`);
    }
  }

  console.log(`\nIteration ${iteration} complete.`);
}

console.log("\nReached MAX_ITERATIONS. Stopping.");
