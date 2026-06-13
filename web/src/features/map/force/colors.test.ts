import { describe, expect, it } from 'vitest';
import { communityColor, communityHue, HUE_MIN, HUE_SPAN } from './colors';

// Status/accent hues that community fills must never collide with:
//   crit  ~  0 (red)      --crit  #f87171
//   warn  ~ 45 (amber)    --warn  #fbbf24
//   ok    ~158 (green)    --ok    #34d399
//   accent~142 (green)    --accent#4ade80
// The forbidden bands (with margin) cover red, yellow, and green.
const FORBIDDEN: [number, number][] = [
  [0, 20], // red
  [340, 360], // red (wrap)
  [35, 70], // amber/yellow
  [90, 170], // green
];

const inAnyBand = (hue: number) => FORBIDDEN.some(([lo, hi]) => hue >= lo && hue <= hi);

describe('community colors', () => {
  it('keeps every community hue inside the safe arc', () => {
    for (let i = 0; i < 200; i++) {
      const h = communityHue(i);
      expect(h).toBeGreaterThanOrEqual(HUE_MIN);
      expect(h).toBeLessThanOrEqual(HUE_MIN + HUE_SPAN);
    }
  });

  it('never lands on a red, yellow, or green hue reserved for status', () => {
    for (let i = 0; i < 200; i++) {
      expect(inAnyBand(communityHue(i))).toBe(false);
    }
  });

  it('spreads the first several communities apart', () => {
    const hues = [0, 1, 2, 3, 4].map(communityHue);
    const uniq = new Set(hues.map((h) => Math.round(h)));
    expect(uniq.size).toBe(5);
  });

  it('is deterministic per community id', () => {
    expect(communityColor(3, 'dark')).toBe(communityColor(3, 'dark'));
  });

  it('emits a valid hsl() string tuned per theme', () => {
    expect(communityColor(0, 'dark')).toMatch(/^hsl\(\d+, 62%, 62%\)$/);
    expect(communityColor(0, 'light')).toMatch(/^hsl\(\d+, 60%, 42%\)$/);
  });
});
