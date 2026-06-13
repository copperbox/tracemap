import { describe, expect, it } from 'vitest';
import { ANIM_MS, easeOut } from './animation';

describe('easeOut', () => {
  it('starts at 0 and ends at 1', () => {
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
  });

  it('matches the cubic ease-out curve at the midpoint', () => {
    expect(easeOut(0.5)).toBeCloseTo(0.875, 10);
  });

  it('is monotonically increasing', () => {
    let prev = easeOut(0);
    for (let t = 0.05; t <= 1.0001; t += 0.05) {
      const v = easeOut(t);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });

  it('is front-loaded (decelerating)', () => {
    expect(easeOut(0.25)).toBeGreaterThan(0.25);
  });
});

describe('ANIM_MS', () => {
  it('is a positive duration', () => {
    expect(ANIM_MS).toBeGreaterThan(0);
  });
});
