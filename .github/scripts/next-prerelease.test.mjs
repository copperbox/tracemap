import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextPrerelease } from './next-prerelease.mjs';

test('the first pre-release of a version is pre.1', () => {
  assert.equal(nextPrerelease('0.3.0', []), 'v0.3.0-pre.1');
});

test('counts up from the highest pre-release of the same version', () => {
  const tags = ['v0.3.0-pre.1', 'v0.3.0-pre.2', 'v0.3.0-pre.10', 'v0.2.0-pre.40'];
  assert.equal(nextPrerelease('0.3.0', tags), 'v0.3.0-pre.11');
});

test('a raised package version starts again at pre.1', () => {
  assert.equal(nextPrerelease('0.4.0', ['v0.3.0-pre.7', 'v0.3.0']), 'v0.4.0-pre.1');
});

test('moves to the next patch once the package version is released', () => {
  assert.equal(nextPrerelease('0.3.0', ['v0.3.0-pre.7', 'v0.3.0']), 'v0.3.1-pre.1');
  assert.equal(nextPrerelease('0.3.0', ['v0.3.0', 'v0.3.1-pre.1']), 'v0.3.1-pre.2');
});

test('never sorts below a later release', () => {
  assert.equal(nextPrerelease('0.3.0', ['v0.3.0', 'v0.10.2', 'v0.9.9']), 'v0.10.3-pre.1');
});

test('ignores tags that are not releases or pre-releases of this version', () => {
  const tags = ['latest', 'v0.3.0-pre.x', 'v0.3.0-rc.5', 'v0.3.0-pre.2-hotfix', 'release-0.3.0', 'v0.3'];
  assert.equal(nextPrerelease('0.3.0', tags), 'v0.3.0-pre.1');
});

test('rejects a package version that is not X.Y.Z', () => {
  assert.throws(() => nextPrerelease('0.3', []), /X\.Y\.Z/);
  assert.throws(() => nextPrerelease('0.3.0-beta.1', []), /X\.Y\.Z/);
});
