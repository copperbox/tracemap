#!/usr/bin/env node
/**
 * Prints the tag for the next pre-release, v<version>-pre.<n>.
 *
 * <version> is the version in the root package.json: the release being worked
 * toward. If a release with that version or a later one already exists, it is
 * the patch version after the latest release, so a pre-release never sorts
 * below a published release. <n> counts up from 1 for each version.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

const numbers = (match) => match.slice(1, 4).map(Number);
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * @param {string} packageVersion the version field of package.json
 * @param {string[]} tags every tag in the repository
 */
export function nextPrerelease(packageVersion, tags) {
  const parsed = VERSION.exec(packageVersion);
  if (!parsed) throw new Error(`package.json version must be X.Y.Z, got "${packageVersion}"`);
  let base = numbers(parsed);

  const releases = tags.map((t) => RELEASE_TAG.exec(t)).filter(Boolean).map(numbers).sort(compare);
  const latest = releases.at(-1);
  if (latest && compare(base, latest) <= 0) base = [latest[0], latest[1], latest[2] + 1];

  const prefix = `v${base.join('.')}-pre.`;
  let n = 0;
  for (const tag of tags) {
    if (!tag.startsWith(prefix)) continue;
    const rest = tag.slice(prefix.length);
    if (/^\d+$/.test(rest)) n = Math.max(n, Number(rest));
  }
  return `${prefix}${n + 1}`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
  const tags = execFileSync('git', ['tag', '--list'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  console.log(nextPrerelease(version, tags));
}
