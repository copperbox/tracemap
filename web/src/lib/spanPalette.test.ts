import { describe, expect, it } from 'vitest';
import { buildSpanColors, HUE_MIN, HUE_SPAN, paletteColor, paletteHue } from './spanPalette';

describe('spanPalette', () => {
  it('keeps hues within the safe cool->pink arc (never red/amber/green)', () => {
    for (let i = 0; i < 50; i++) {
      const h = paletteHue(i);
      expect(h).toBeGreaterThanOrEqual(HUE_MIN);
      expect(h).toBeLessThanOrEqual(HUE_MIN + HUE_SPAN);
    }
  });

  it('spreads consecutive hues apart for distinctness', () => {
    const hues = [0, 1, 2, 3, 4].map(paletteHue);
    for (let i = 1; i < hues.length; i++) {
      expect(Math.abs(hues[i] - hues[i - 1])).toBeGreaterThan(20);
    }
  });

  it('emits theme-tuned hsl() colors', () => {
    expect(paletteColor(0, 'dark')).toMatch(/^hsl\(\d+, 62%, 62%\)$/);
    expect(paletteColor(0, 'light')).toMatch(/^hsl\(\d+, 60%, 42%\)$/);
    // Deterministic per index.
    expect(paletteColor(3, 'dark')).toBe(paletteColor(3, 'dark'));
  });

  describe('buildSpanColors', () => {
    it('assigns a distinct color to each service', () => {
      const colors = buildSpanColors(['a', 'b', 'c', 'd'], 'dark');
      expect(colors.size).toBe(4);
      expect(new Set(colors.values()).size).toBe(4);
    });

    it('de-duplicates and orders services so colors are stable per trace', () => {
      const colors = buildSpanColors(['orders', 'api', 'orders', 'redis'], 'dark');
      expect([...colors.keys()]).toEqual(['api', 'orders', 'redis']);
      // First service (sorted) takes the first slot of the shared scale.
      expect(colors.get('api')).toBe(paletteColor(0, 'dark'));
    });

    it('is order-independent given the same set of services', () => {
      const a = buildSpanColors(['x', 'y', 'z'], 'light');
      const b = buildSpanColors(['z', 'x', 'y'], 'light');
      expect([...a]).toEqual([...b]);
    });
  });
});
