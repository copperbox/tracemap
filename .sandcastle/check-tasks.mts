// Pre-flight issue queries for the Sandcastle planner, run on the HOST (before
// any sandbox spins up).
//
//   - checkTasks()              -> open, Sandcastle-labelled issues that are NOT
//                                  already in review (i.e. not yet parked behind
//                                  an open feature PR). This is the planner's
//                                  work queue.
//   - getInReviewIssueNumbers() -> open issues currently carrying the in-review
//                                  label, used by main.mts to reconcile issues
//                                  whose feature PR was closed without merging.
//
// PR-side helpers (opening/updating feature PRs, applying the in-review label)
// live in feature-pr.mts.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// The label that marks an issue as fair game for Sandcastle. Matched
// case-insensitively against each issue's label names.
export const SANDCASTLE_LABEL = "Sandcastle";

// Applied to an issue once its work has landed on a feature branch and been
// rolled into a feature PR. In-review issues are excluded from the work queue so
// the planner never re-does work that is already waiting for human review; the
// label is removed again if that PR is closed without merging (see main.mts).
export const IN_REVIEW_LABEL = "sandcastle:in-review";

// The shape emitted by the gh --jq projection below, one entry per issue.
export interface SandcastleIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  comments: string[];
}

// Run a gh subcommand on the host and return stdout. execFile (no shell) means
// arguments are passed literally, so issue bodies never get shell-interpreted.
async function gh(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("gh", args, {
    encoding: "utf8",
    // Bodies + comments for 100 issues can be large; give the buffer headroom.
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

// Fetch open issues from GitHub and keep only those that carry the Sandcastle
// label AND are not already in review. Returns an empty array when there is
// nothing queued to work on.
export async function checkTasks(): Promise<SandcastleIssue[]> {
  const stdout = await gh([
    "issue",
    "list",
    "--state",
    "open",
    "--label",
    SANDCASTLE_LABEL,
    "--limit",
    "100",
    "--json",
    "number,title,body,labels,comments",
    "--jq",
    "[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]",
  ]);

  const issues = JSON.parse(stdout) as SandcastleIssue[];

  return issues.filter((issue) => {
    const labels = issue.labels.map((l) => l.toLowerCase());
    const isSandcastle = labels.includes(SANDCASTLE_LABEL.toLowerCase());
    const inReview = labels.includes(IN_REVIEW_LABEL.toLowerCase());
    return isSandcastle && !inReview;
  });
}

// The open issue numbers currently labelled in-review. Used to detect issues
// whose feature PR was closed unmerged (they must be requeued).
export async function getInReviewIssueNumbers(): Promise<number[]> {
  const stdout = await gh([
    "issue",
    "list",
    "--state",
    "open",
    "--label",
    IN_REVIEW_LABEL,
    "--limit",
    "100",
    "--json",
    "number",
    "--jq",
    "[.[].number]",
  ]);

  return JSON.parse(stdout) as number[];
}
