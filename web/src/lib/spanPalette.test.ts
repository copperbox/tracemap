import { describe, expect, it } from 'vitest';
import { SPAN_PALETTES, svcColor, svcColorIndex } from './spanPalette';

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastOnWhite(hex: string): number {
  return 1.05 / (luminance(hex) + 0.05);
}

describe('spanPalette', () => {
  it('palettes cover the same hue slots', () => {
    expect(SPAN_PALETTES.dark.length).toBe(SPAN_PALETTES.light.length);
    for (const theme of ['dark', 'light'] as const) {
      for (const c of SPAN_PALETTES[theme]) expect(c).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it('hashes a service id to a stable palette index', () => {
    const i = svcColorIndex('checkout-svc');
    expect(i).toBe(svcColorIndex('checkout-svc'));
    expect(i).toBeGreaterThanOrEqual(0);
    expect(i).toBeLessThan(SPAN_PALETTES.dark.length);
  });

  it('keeps the same hue slot for a service across themes', () => {
    const i = svcColorIndex('payments-svc');
    expect(svcColor('payments-svc', 'dark')).toBe(SPAN_PALETTES.dark[i]);
    expect(svcColor('payments-svc', 'light')).toBe(SPAN_PALETTES.light[i]);
  });

  it('light palette colors stay legible on white panels', () => {
    for (const c of SPAN_PALETTES.light) {
      expect(contrastOnWhite(c), `${c} contrast on white`).toBeGreaterThanOrEqual(4);
    }
  });
});
