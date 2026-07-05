// Parallel Planner with Review — four-phase orchestration loop
//
// This template drives a multi-phase workflow:
//   Phase 1 (Plan):             An opus agent analyzes open issues, builds a
//                               dependency graph, and outputs a <plan> JSON
//                               listing unblocked issues with branch names.
//   Phase 2 (Execute + Review): For each issue, a sandbox is created via
//                               createSandbox(). The implementer runs first
//                               (100 iterations). If the branch is then ahead
//                               of the target (regardless of which run made the
//                               commits), a reviewer runs in the same sandbox on
//                               the same branch (1 iteration); a reviewer failure
//                               is logged but never discards committed work. All
//                               issue pipelines run concurrently via
//                               Promise.allSettled().
//   Phase 3 (Merge):            A single agent merges all completed branches
//                               into the current branch.
//
// The outer loop repeats up to MAX_ITERATIONS times so that newly unblocked
// issues are picked up after each round of merges.
//
// Usage:
//   npx tsx .sandcastle/main.mts
// Or add to package.json:
//   "scripts": { "sandcastle": "npx tsx .sandcastle/main.mts" }

import { exit } from "node:process";
import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { z } from "zod";
import { checkTasks } from "./check-tasks.mts";

// The planner emits its plan as JSON inside <plan> tags; Output.object extracts
// and validates it against this schema. We use Zod here, but any Standard
// Schema validator works just as well — Valibot, ArkType, etc. See
// https://standardschema.dev.
const planSchema = z.object({
  issues: z.array(
    z.object({ id: z.string(), title: z.string(), branch: z.string() }),
  ),
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Maximum number of plan→execute→merge cycles before stopping.
// Raise this if your backlog is large; lower it for a quick smoke-test run.
const MAX_ITERATIONS = 10;

// Exit code used when there is no work to do (no Sandcastle-labelled issues, or
// every open issue is blocked). Distinct from 0 (worked through the backlog
// cleanly) and 1 (a crash/thrown error) so a supervising loop — e.g.
// scripts/sandcastle-loop.sh — can tell "idle, stop polling" apart from both a
// normal completion and a real failure.
const IDLE_EXIT_CODE = 3;

// The branch that completed work is reviewed against and merged into. Must match
// the repo's base branch (Sandcastle also injects it into the reviewer/merger
// prompts as {{TARGET_BRANCH}}). The branch-state gate below asks git how far a
// work branch is ahead of this ref.
const TARGET_BRANCH = "main";

// Hooks run inside the sandbox before the agent starts each iteration.
// npm install ensures the sandbox always has fresh dependencies.
const hooks = {
  sandbox: { onSandboxReady: [{ command: "npm install" }] },
};

// Copy node_modules from the host into the worktree before each sandbox
// starts. Avoids a full npm install from scratch; the hook above handles
// platform-specific binaries and any packages added since the last copy.
const copyToWorktree = ["node_modules"];

// Count the commits a work branch carries that the target branch does not yet
// have. This — not "did this agent invocation commit?" — is the source of truth
// for "is there work to review and merge?". It reflects the branch's actual
// state, so work committed in an earlier iteration (whose reviewer may have
// crashed) is still picked up by a later iteration even if that iteration's
// implementer adds nothing new. Runs inside the sandbox, where `exec` defaults
// its cwd to the worktree repo.
async function branchCommitsAhead(
  sandbox: sandcastle.Sandbox,
  target: string,
  branch: string,
): Promise<{ sha: string }[]> {
  const res = await sandbox.exec(`git rev-list ${target}..${branch}`);
  if (res.exitCode !== 0) {
    throw new Error(
      `git rev-list ${target}..${branch} failed (exit ${res.exitCode}): ${res.stderr.trim()}`,
    );
  }
  return res.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((sha) => ({ sha }));
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

  // -------------------------------------------------------------------------
  // Phase 0: Pre-flight issue check
  //
  // Fetch the Sandcastle-labelled open issues on the HOST before spinning up
  // any sandbox. If there are none, there is nothing to plan — skip the entire
  // plan→execute→merge cycle so we don't pay for a needless planner run.
  // -------------------------------------------------------------------------
  const openIssues = await checkTasks();

  if (openIssues.length === 0) {
    console.log("No open Sandcastle-labelled issues to work on. Exiting.");
    exit(IDLE_EXIT_CODE);
  }

  console.log(`Found ${openIssues.length} Sandcastle-labelled open issue(s).`);

  // -------------------------------------------------------------------------
  // Phase 1: Plan
  //
  // The planning agent (opus, for deeper reasoning) reads the open issue list,
  // builds a dependency graph, and selects the issues that can be worked in
  // parallel right now (i.e., no blocking dependencies on other open issues).
  //
  // The issue list is fetched once above and injected via promptArgs, so the
  // planner prompt doesn't re-invoke gh itself.
  //
  // It outputs a <plan> JSON block — Output.object parses and validates it.
  // -------------------------------------------------------------------------
  const plan = await sandcastle.run({
    hooks,
    sandbox: docker(),
    name: "planner",
    // One iteration is enough: the planner just needs to read and reason,
    // not write code. (Structured output requires maxIterations: 1.)
    maxIterations: 1,
    // Opus for planning: dependency analysis benefits from deeper reasoning.
    agent: sandcastle.claudeCode("claude-opus-4-8"),
    promptFile: "./.sandcastle/plan-prompt.md",
    promptArgs: {
      // The pre-filtered issue list, injected into the {{ISSUES_JSON}}
      // placeholder in plan-prompt.md.
      ISSUES_JSON: JSON.stringify(openIssues, null, 2),
    },
    // Extract and validate the <plan> JSON into a typed object. Throws
    // StructuredOutputError if the tag is missing, the JSON is malformed, or
    // validation fails — which aborts the loop.
    output: sandcastle.Output.object({ tag: "plan", schema: planSchema }),
  });

  const issues = plan.output.issues;

  if (issues.length === 0) {
    // No unblocked work — either everything is done or everything is blocked.
    console.log("No unblocked issues to work on. Exiting.");
    exit(IDLE_EXIT_CODE);
  }

  console.log(
    `Planning complete. ${issues.length} issue(s) to work in parallel:`,
  );
  for (const issue of issues) {
    console.log(`  ${issue.id}: ${issue.title} → ${issue.branch}`);
  }

  // -------------------------------------------------------------------------
  // Phase 2: Execute + Review
  //
  // For each issue, create a sandbox via createSandbox() so the implementer
  // and reviewer share the same sandbox instance per branch. The implementer
  // runs first; the reviewer then runs whenever the branch is ahead of the
  // target (branch-state gate), not merely when this run committed.
  //
  // Promise.allSettled means one failing pipeline doesn't cancel the others.
  // -------------------------------------------------------------------------

  const settled = await Promise.allSettled(
    issues.map(async (issue) => {
      const sandbox = await sandcastle.createSandbox({
        branch: issue.branch,
        sandbox: docker(),
        hooks,
        copyToWorktree,
      });

      try {
        // Run the implementer
        const implement = await sandbox.run({
          name: "implementer",
          maxIterations: 100,
          agent: sandcastle.claudeCode("claude-opus-4-8"),
          promptFile: "./.sandcastle/implement-prompt.md",
          promptArgs: {
            TASK_ID: issue.id,
            ISSUE_TITLE: issue.title,
            BRANCH: issue.branch,
          },
        });

        if (implement.completionSignal === undefined) {
          // The implementer stopped without signalling completion — it hit its
          // iteration cap or ran out of context. Any commits it managed to make
          // are still on the branch and are handled by the branch-state check
          // below; we just surface that the run ended early.
          console.warn(
            `  ⚠ ${issue.id} implementer stopped without a completion signal (iteration cap or context limit).`,
          );
        }

        // Gate review + merge on the BRANCH's state, not on whether this
        // particular implementer invocation committed. A prior iteration can
        // leave the branch ahead of the target with unreviewed work (e.g. its
        // reviewer crashed on an oversized prompt); a later iteration whose
        // implementer adds nothing new must still trigger review and merge.
        const commits = await branchCommitsAhead(
          sandbox,
          TARGET_BRANCH,
          issue.branch,
        );

        if (commits.length === 0) {
          // Branch has nothing the target doesn't already have.
          return { branch: issue.branch, commits };
        }

        // The branch carries commits to review. A reviewer failure (prompt too
        // long, transient API error, etc.) must NOT discard the implementer's
        // committed work: log it and fall through so the branch still reaches
        // the merge phase with its commits intact.
        try {
          await sandbox.run({
            name: "reviewer",
            maxIterations: 1,
            agent: sandcastle.claudeCode("claude-opus-4-8"),
            promptFile: "./.sandcastle/review-prompt.md",
            promptArgs: {
              BRANCH: issue.branch,
            },
          });
        } catch (err) {
          console.error(
            `  ⚠ reviewer failed on ${issue.branch}: ${
              err instanceof Error ? err.message : err
            }. Keeping committed work for merge.`,
          );
        }

        // Re-read the branch state: the reviewer may have added refinement
        // commits. Reporting the branch's true ahead-of-target set means the
        // merge phase picks up all of it regardless of which run produced what.
        return {
          branch: issue.branch,
          commits: await branchCommitsAhead(sandbox, TARGET_BRANCH, issue.branch),
        };
      } finally {
        await sandbox.close();
      }
    }),
  );

  // Log any agents that threw (network error, sandbox crash, etc.).
  for (const [i, outcome] of settled.entries()) {
    if (outcome.status === "rejected") {
      console.error(
        `  ✗ ${issues[i]!.id} (${issues[i]!.branch}) failed: ${outcome.reason}`,
      );
    }
  }

  // Only pass branches that actually produced commits to the merge phase.
  // An agent that ran successfully but made no commits has nothing to merge.
  const completedIssues = settled
    .map((outcome, i) => ({ outcome, issue: issues[i]! }))
    .filter(
      (entry) =>
        entry.outcome.status === "fulfilled" &&
        entry.outcome.value.commits.length > 0,
    )
    .map((entry) => entry.issue);

  const completedBranches = completedIssues.map((i) => i.branch);

  console.log(
    `\nExecution complete. ${completedBranches.length} branch(es) with commits:`,
  );
  for (const branch of completedBranches) {
    console.log(`  ${branch}`);
  }

  if (completedBranches.length === 0) {
    // All agents ran but none made commits — nothing to merge this cycle.
    console.log("No commits produced. Nothing to merge.");
    continue;
  }

  // -------------------------------------------------------------------------
  // Phase 3: Merge
  //
  // One agent merges all completed branches into the current branch,
  // resolving any conflicts and running tests to confirm everything works.
  //
  // The {{BRANCHES}} and {{ISSUES}} prompt arguments are lists that the agent
  // uses to know which branches to merge and which issues to close.
  // -------------------------------------------------------------------------
  await sandcastle.run({
    hooks,
    sandbox: docker(),
    name: "merger",
    maxIterations: 1,
    agent: sandcastle.claudeCode("claude-opus-4-8"),
    promptFile: "./.sandcastle/merge-prompt.md",
    promptArgs: {
      // A markdown list of branch names, one per line.
      BRANCHES: completedBranches.map((b) => `- ${b}`).join("\n"),
      // A markdown list of issue IDs and titles, one per line.
      ISSUES: completedIssues.map((i) => `- ${i.id}: ${i.title}`).join("\n"),
    },
  });

  console.log("\nBranches merged.");
}

console.log("\nAll done.");
