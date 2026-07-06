// Host-side helpers for the feature-branch + PR workflow.
//
// Everything here runs on the HOST (never inside a docker sandbox) so it can use
// the host's existing `gh`/git credentials to push branches and open PRs. The
// sandboxes share the host repo's git state (worktrees under
// .sandcastle/worktrees/), so a branch a sandbox committed to is visible here
// and can be pushed straight to origin.
//
// The feature PR is the workflow's persistent record of a feature: its head
// branch is `sandcastle/feature-<slug>`, and a machine-readable marker in its
// body records the full, fixed member issue list. Reading open feature PRs back
// (getOpenFeaturePRs) is how grouping survives across planner runs.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { IN_REVIEW_LABEL } from "./check-tasks.mts";

const execFileAsync = promisify(execFile);

// Branch that feature branches fork from and that feature PRs target.
export const TARGET_BRANCH = "main";

// Prefix identifying a feature integration branch (and thus a feature PR).
export const FEATURE_BRANCH_PREFIX = "sandcastle/feature-";

// Prefix for per-issue branches. Deterministic and independent of feature
// grouping, so an issue's work is always locatable regardless of how (or how
// many times) the planner groups it.
export const ISSUE_BRANCH_PREFIX = "sandcastle/issue-";

// The deterministic branch name for an issue.
export function issueBranch(id: string | number): string {
  return `${ISSUE_BRANCH_PREFIX}${id}`;
}

// Subject prefix marking the single version-bump commit on a feature branch.
// Its presence is how we keep the bump idempotent across re-runs/crashes.
const RELEASE_COMMIT_PREFIX = "chore(release):";

// Leading token of the HTML-comment marker embedded in every feature PR body.
const MARKER_PREFIX = "<!-- sandcastle-feature:";

// One member issue of a feature.
export interface FeatureMember {
  id: string;
  title: string;
}

// A feature as persisted in an open PR's marker.
export interface FeaturePR {
  slug: string;
  branch: string;
  prNumber: number;
  isDraft: boolean;
  members: FeatureMember[];
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

async function run(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (err: unknown) {
    // execFile rejects on non-zero exit; surface code/stderr instead of throwing
    // so callers can decide what is fatal (a push failure) vs. expected (a label
    // that already exists).
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? String(err),
      code: typeof e.code === "number" ? e.code : 1,
    };
  }
}

async function git(args: string[]) {
  return run("git", args);
}

async function gh(args: string[]) {
  return run("gh", args);
}

// ---------------------------------------------------------------------------
// Marker (feature membership persisted in the PR body)
// ---------------------------------------------------------------------------

// Titles are embedded in a JSON HTML comment; strip anything that could break
// out of the comment or the JSON line.
function sanitizeTitle(title: string): string {
  return title.replace(/--+>/g, "->").replace(/[\r\n]+/g, " ").trim();
}

export function buildMarker(feature: {
  slug: string;
  branch: string;
  members: FeatureMember[];
}): string {
  const payload = JSON.stringify({
    slug: feature.slug,
    branch: feature.branch,
    members: feature.members.map((m) => ({
      id: String(m.id),
      title: sanitizeTitle(m.title),
    })),
  });
  return `${MARKER_PREFIX} ${payload} -->`;
}

export function parseMarker(
  body: string,
): { slug: string; branch: string; members: FeatureMember[] } | null {
  const m = body.match(/<!-- sandcastle-feature:\s*(\{[\s\S]*?\})\s*-->/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1]) as {
      slug: string;
      branch: string;
      members: FeatureMember[];
    };
    if (!Array.isArray(parsed.members)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// PR body
// ---------------------------------------------------------------------------

// Build the full PR body: marker (for our own parsing) + a human checklist +
// the generated summary + `Closes #N` lines for members that are done (so a
// merge auto-closes exactly the issues whose work is actually included).
export function buildFeatureBody(feature: {
  slug: string;
  branch: string;
  members: FeatureMember[];
  doneIds: Set<string>;
  description: string | null;
  release?: { version: string; level: string | null } | null;
}): string {
  const marker = buildMarker(feature);
  const checklist = feature.members
    .map((m) => `- [${feature.doneIds.has(String(m.id)) ? "x" : " "}] #${m.id} ${m.title}`)
    .join("\n");
  const closes = feature.members
    .filter((m) => feature.doneIds.has(String(m.id)))
    .map((m) => `Closes #${m.id}`)
    .join("\n");
  const summary =
    feature.description ??
    "_A detailed summary is added once every issue in this feature is complete._";

  const releaseSection = feature.release
    ? [
        "### Release",
        `\`v${feature.release.version}\`${
          feature.release.level ? ` (${feature.release.level} bump)` : ""
        }`,
        "",
      ]
    : [];

  return [
    marker,
    "",
    `**Automated feature branch assembled by Sandcastle.** Review the changes and merge into \`${TARGET_BRANCH}\` when ready.`,
    "",
    "### Issues in this feature",
    checklist,
    "",
    ...releaseSection,
    "### Summary",
    summary,
    "",
    closes,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

// Create the in-review label if it does not already exist. Idempotent: gh exits
// non-zero when the label exists, which we treat as success.
export async function ensureInReviewLabel(): Promise<void> {
  const res = await gh([
    "label",
    "create",
    IN_REVIEW_LABEL,
    "--color",
    "BFD4F2",
    "--description",
    "Sandcastle work is complete and waiting in a feature PR for human review",
  ]);
  if (res.code !== 0 && !/already exists/i.test(res.stderr)) {
    throw new Error(`failed to ensure label ${IN_REVIEW_LABEL}: ${res.stderr.trim()}`);
  }
}

export async function addInReview(issueId: string | number): Promise<void> {
  const res = await gh([
    "issue",
    "edit",
    String(issueId),
    "--add-label",
    IN_REVIEW_LABEL,
  ]);
  if (res.code !== 0) {
    throw new Error(`failed to label issue #${issueId} in-review: ${res.stderr.trim()}`);
  }
}

export async function removeInReview(issueId: string | number): Promise<void> {
  const res = await gh([
    "issue",
    "edit",
    String(issueId),
    "--remove-label",
    IN_REVIEW_LABEL,
  ]);
  if (res.code !== 0) {
    throw new Error(`failed to unlabel issue #${issueId}: ${res.stderr.trim()}`);
  }
}

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

// Create the feature branch off TARGET_BRANCH if it does not exist yet. Creating
// a ref does not touch any worktree's HEAD, so it is safe while sandboxes run.
export async function ensureFeatureBranch(branch: string): Promise<void> {
  const exists = await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (exists.code === 0) return;
  const created = await git(["branch", branch, TARGET_BRANCH]);
  if (created.code !== 0) {
    throw new Error(`failed to create branch ${branch}: ${created.stderr.trim()}`);
  }
}

// Push the feature branch to origin. Plain (non-force) push: the branch only
// ever grows by merges, so a fast-forward push is expected.
export async function pushBranch(branch: string): Promise<void> {
  const res = await git(["push", "-u", "origin", branch]);
  if (res.code !== 0) {
    throw new Error(`failed to push ${branch}: ${res.stderr.trim()}`);
  }
}

// Whether a local branch ref exists.
export async function branchExists(branch: string): Promise<boolean> {
  const res = await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  return res.code === 0;
}

// Count commits reachable from `branch` but not `base` (i.e. `base..branch`).
// Returns 0 on any error (e.g. a missing ref) so callers can treat "no work" and
// "cannot tell" identically. This is the source of truth for integration state:
// an issue branch with `commitsAhead(feature) === 0` is fully merged into the
// feature branch, regardless of which run performed the merge.
export async function commitsAhead(base: string, branch: string): Promise<number> {
  const res = await git(["rev-list", "--count", `${base}..${branch}`]);
  if (res.code !== 0) return 0;
  const n = Number.parseInt(res.stdout.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

// Whether an issue's work is fully integrated into a feature branch: its branch
// exists, carries real commits (ahead of TARGET_BRANCH), and none of them are
// missing from the feature branch.
export async function isIssueIntegrated(
  issueId: string,
  featureBranch: string,
): Promise<boolean> {
  const b = issueBranch(issueId);
  if (!(await branchExists(b))) return false;
  if ((await commitsAhead(TARGET_BRANCH, b)) === 0) return false;
  return (await commitsAhead(featureBranch, b)) === 0;
}

// The member ids that count as "done": closed, already labelled in-review, OR
// fully integrated into the feature branch (even if not yet labelled -- git
// state is the source of truth, so a crash between merge and label doesn't lose
// the fact that the work landed).
export async function effectiveDoneIds(
  memberIds: string[],
  featureBranch: string,
): Promise<Set<string>> {
  const done = await getFeatureDoneIds(memberIds);
  await Promise.all(
    memberIds.map(async (id) => {
      if (done.has(id)) return;
      if (await isIssueIntegrated(id, featureBranch)) done.add(id);
    }),
  );
  return done;
}

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

// Read the version field of the root package.json at a given git ref.
export async function readVersion(ref: string): Promise<string> {
  const res = await git(["show", `${ref}:package.json`]);
  if (res.code !== 0) return "0.0.0";
  try {
    return (JSON.parse(res.stdout) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// The `chore(release):` commit subjects a branch carries beyond TARGET_BRANCH.
async function releaseSubjects(branch: string): Promise<string[]> {
  const res = await git(["log", "--format=%s", `${TARGET_BRANCH}..${branch}`]);
  if (res.code !== 0) return [];
  return res.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.startsWith(RELEASE_COMMIT_PREFIX));
}

// Whether the feature branch already carries its version-bump commit. Used to
// make the bump exactly-once even if a run is killed after committing it.
export async function hasReleaseCommit(branch: string): Promise<boolean> {
  return (await releaseSubjects(branch)).length > 0;
}

// The semver level recorded in the release commit subject (e.g. "minor" from
// "chore(release): v0.2.0 (minor)"), or null if none is found.
export async function readReleaseLevel(branch: string): Promise<string | null> {
  for (const subject of await releaseSubjects(branch)) {
    const m = subject.match(/\((patch|minor|major)\)/i);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

// Compare two "x.y.z" versions numerically. Negative if a<b, 0 if equal,
// positive if a>b.
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// Whether a feature branch's version collides with TARGET_BRANCH. Only ready
// (already-bumped) features qualify: if such a branch's version is no longer
// strictly greater than TARGET_BRANCH's current version, another PR merged and
// took that version, so this one must re-bump on top of the new base. Call this
// AFTER syncMainFromOrigin() so TARGET_BRANCH reflects what is actually merged.
export async function needsRebump(branch: string): Promise<boolean> {
  if (!(await hasReleaseCommit(branch))) return false;
  const featureVersion = await readVersion(branch);
  const mainVersion = await readVersion(TARGET_BRANCH);
  return compareVersions(featureVersion, mainVersion) <= 0;
}

// Bring the local TARGET_BRANCH up to date with origin so every downstream
// computation (new feature bases, version reads, collision detection) reflects
// what is actually merged. Fast-forward only -- the orchestrator never commits
// to TARGET_BRANCH, so a non-ff state is unexpected and left untouched with a
// warning rather than clobbered.
export async function syncMainFromOrigin(): Promise<void> {
  const fetched = await git(["fetch", "origin", TARGET_BRANCH]);
  if (fetched.code !== 0) {
    console.warn(
      `  ⚠ git fetch origin ${TARGET_BRANCH} failed: ${fetched.stderr.trim()}. Using local ${TARGET_BRANCH}.`,
    );
    return;
  }

  // Only advance local TARGET_BRANCH when it is an ancestor of origin's (behind
  // or equal). Otherwise it has diverged/is ahead -> leave it alone.
  const isAncestor = await git([
    "merge-base",
    "--is-ancestor",
    TARGET_BRANCH,
    `origin/${TARGET_BRANCH}`,
  ]);
  if (isAncestor.code !== 0) return;

  const head = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const onTarget = head.code === 0 && head.stdout.trim() === TARGET_BRANCH;
  // If TARGET_BRANCH is the checked-out branch, ff-merge it (moves the worktree
  // too); otherwise move the ref directly (safe: it isn't checked out anywhere).
  const updated = onTarget
    ? await git(["merge", "--ff-only", `origin/${TARGET_BRANCH}`])
    : await git(["branch", "-f", TARGET_BRANCH, `origin/${TARGET_BRANCH}`]);
  if (updated.code !== 0) {
    console.warn(`  ⚠ could not fast-forward ${TARGET_BRANCH}: ${updated.stderr.trim()}`);
  }
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

// Every open feature PR, decoded from its marker. PRs whose head matches the
// feature prefix but that carry no valid marker are skipped (with a warning) --
// we cannot know their membership, so we leave them alone.
export async function getOpenFeaturePRs(): Promise<FeaturePR[]> {
  const res = await gh([
    "pr",
    "list",
    "--state",
    "open",
    "--limit",
    "100",
    "--json",
    "number,headRefName,isDraft,body",
  ]);
  if (res.code !== 0) {
    throw new Error(`failed to list PRs: ${res.stderr.trim()}`);
  }

  const prs = JSON.parse(res.stdout) as {
    number: number;
    headRefName: string;
    isDraft: boolean;
    body: string;
  }[];

  const features: FeaturePR[] = [];
  for (const pr of prs) {
    if (!pr.headRefName.startsWith(FEATURE_BRANCH_PREFIX)) continue;
    const marker = parseMarker(pr.body ?? "");
    if (!marker) {
      console.warn(
        `  ⚠ feature PR #${pr.number} (${pr.headRefName}) has no readable marker; skipping.`,
      );
      continue;
    }
    features.push({
      slug: marker.slug,
      branch: pr.headRefName,
      prNumber: pr.number,
      isDraft: pr.isDraft,
      members: marker.members,
    });
  }
  return features;
}

// Find an open PR for a given head branch, if any.
export async function findFeaturePR(
  branch: string,
): Promise<{ prNumber: number; isDraft: boolean; body: string } | null> {
  const res = await gh([
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    "open",
    "--json",
    "number,isDraft,body",
  ]);
  if (res.code !== 0) {
    throw new Error(`failed to look up PR for ${branch}: ${res.stderr.trim()}`);
  }
  const prs = JSON.parse(res.stdout) as {
    number: number;
    isDraft: boolean;
    body: string;
  }[];
  const pr = prs[0];
  return pr ? { prNumber: pr.number, isDraft: pr.isDraft, body: pr.body } : null;
}

// Open a draft PR for the feature branch. The branch must already be pushed.
export async function createDraftPR(opts: {
  branch: string;
  title: string;
  body: string;
}): Promise<number> {
  const res = await gh([
    "pr",
    "create",
    "--draft",
    "--base",
    TARGET_BRANCH,
    "--head",
    opts.branch,
    "--title",
    opts.title,
    "--body",
    opts.body,
  ]);
  if (res.code !== 0) {
    throw new Error(`failed to create PR for ${opts.branch}: ${res.stderr.trim()}`);
  }
  const found = await findFeaturePR(opts.branch);
  if (!found) {
    throw new Error(`created PR for ${opts.branch} but could not read it back`);
  }
  return found.prNumber;
}

export async function setPRBody(prNumber: number, body: string): Promise<void> {
  const res = await gh(["pr", "edit", String(prNumber), "--body", body]);
  if (res.code !== 0) {
    throw new Error(`failed to update PR #${prNumber} body: ${res.stderr.trim()}`);
  }
}

// Flip a draft PR to ready-for-review. gh is a no-op if it is already ready.
export async function markReady(prNumber: number): Promise<void> {
  const res = await gh(["pr", "ready", String(prNumber)]);
  if (res.code !== 0) {
    throw new Error(`failed to mark PR #${prNumber} ready: ${res.stderr.trim()}`);
  }
}

// ---------------------------------------------------------------------------
// Completion state
// ---------------------------------------------------------------------------

// The subset of the given issue ids that are "done": either closed, or already
// carrying the in-review label. A feature is ready to review when every member
// is done.
export async function getFeatureDoneIds(
  memberIds: string[],
): Promise<Set<string>> {
  const done = new Set<string>();
  await Promise.all(
    memberIds.map(async (id) => {
      const res = await gh([
        "issue",
        "view",
        id,
        "--json",
        "state,labels",
      ]);
      if (res.code !== 0) return; // treat unreadable as not-done
      const info = JSON.parse(res.stdout) as {
        state: string;
        labels: { name: string }[];
      };
      const closed = info.state.toUpperCase() === "CLOSED";
      const inReview = info.labels.some(
        (l) => l.name.toLowerCase() === IN_REVIEW_LABEL.toLowerCase(),
      );
      if (closed || inReview) done.add(String(id));
    }),
  );
  return done;
}
