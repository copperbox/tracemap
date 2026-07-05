// Pre-flight issue check for the Sandcastle planner.
//
// Runs `gh issue list` on the HOST (before any sandbox spins up), keeps only
// the issues that actually carry the Sandcastle label, and returns just those.
// main.mts uses the result to:
//   (a) skip the entire plan->execute->merge cycle when nothing is labelled to
//       work on, avoiding a needless planner run, and
//   (b) feed the pre-fetched issue list straight into the planner prompt, so
//       plan-prompt.md no longer has to invoke gh a second time itself.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// The label that marks an issue as fair game for Sandcastle. Matched
// case-insensitively against each issue's label names.
const SANDCASTLE_LABEL = "sandcastle";

// The shape emitted by the gh --jq projection below, one entry per issue.
export interface SandcastleIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  comments: string[];
}

// Fetch open issues from GitHub and keep only those carrying the Sandcastle
// label. Returns an empty array when there is nothing to work on.
export async function checkTasks(): Promise<SandcastleIssue[]> {
  const { stdout } = await execFileAsync(
    "gh",
    [
      "issue",
      "list",
      "--state",
      "open",
      "--label",
      "Sandcastle",
      "--limit",
      "100",
      "--json",
      "number,title,body,labels,comments",
      "--jq",
      "[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]",
    ],
    // Bodies + comments for 100 issues can be large; give the buffer headroom.
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );

  const issues = JSON.parse(stdout) as SandcastleIssue[];

  // The gh query already filters on --label Sandcastle, but re-check here so the
  // returned list is guaranteed to contain only Sandcastle-labelled issues
  // regardless of how the query is later tweaked.
  return issues.filter((issue) =>
    issue.labels.some((label) => label.toLowerCase() === SANDCASTLE_LABEL),
  );
}
