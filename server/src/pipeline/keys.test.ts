import { describe, expect, it } from 'vitest';
import { joinKey, key2, key3, splitKey2 } from './keys.js';

const SEP = '\u0001';

describe('composite keys', () => {
  it('do not collide when parts contain the old delimiter, a colon or digits', () => {
    const pairs: [string, string][] = [
      [`a${SEP}b`, 'c'],
      ['a', `b${SEP}c`],
      ['1:a', 'b'],
      ['1', ':ab'],
      ['', '2:ab'],
      ['2:ab', ''],
      ['ab', ''],
      ['a', 'b'],
    ];
    const keys = pairs.map(([a, b]) => key2(a, b));
    expect(new Set(keys).size).toBe(pairs.length);
    for (const [i, [a, b]] of pairs.entries()) expect(splitKey2(keys[i])).toEqual([a, b]);
  });

  it('agree across arities and stay distinct for triples', () => {
    expect(key3('a', 'b', 'c')).toBe(joinKey(['a', 'b', 'c']));
    expect(joinKey(['x'])).toBe('x');
    expect(joinKey([])).toBe('');
    const triples = [[`a${SEP}b`, 'c', 'd'], ['a', `b${SEP}c`, 'd'], ['a', 'b', `c${SEP}d`], ['a:b', 'c', 'd']];
    expect(new Set(triples.map((t) => joinKey(t))).size).toBe(triples.length);
  });
});
