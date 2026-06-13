import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('./global.css', import.meta.url)), 'utf8');

function tokensOf(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const lightBlock = css.match(/body\[data-theme='light'\]\s*\{([^}]*)\}/)?.[1] ?? '';
const darkBlock = css.match(/body\s*\{([^}]*--bg:[^}]*)\}/)?.[1] ?? '';
const light = tokensOf(lightBlock);

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('light theme tokens', () => {
  it('parses both theme blocks', () => {
    expect(light.text).toMatch(/^#/);
    expect(darkBlock).toContain('--text');
  });

  it('body text meets WCAG AA on panels and page background', () => {
    expect(contrast(light.text, light.panel)).toBeGreaterThanOrEqual(7);
    expect(contrast(light.text, light.bg)).toBeGreaterThanOrEqual(7);
    expect(contrast(light.dim, light.panel)).toBeGreaterThanOrEqual(4.5);
  });

  it('status and accent colors stay legible as small text on panels', () => {
    for (const token of ['ok', 'warn', 'crit', 'accent'] as const) {
      expect(contrast(light[token], light.panel), `--${token} on --panel`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('accent buttons keep readable label text', () => {
    expect(contrast(light['accent-ink'], light.accent)).toBeGreaterThanOrEqual(4.5);
  });

  it('faint micro-labels stay above 3:1 on panels', () => {
    expect(contrast(light.faint, light.panel)).toBeGreaterThanOrEqual(3);
  });

  it('map edges get a stronger stroke than hairline borders in light mode', () => {
    const alphaOf = (v: string): number => Number(v.match(/rgba\([^)]*,\s*([\d.]+)\)/)?.[1] ?? NaN);
    // MapView draws idle edges at 0.4 opacity; the light token needs enough
    // alpha to survive that on the dotted canvas (--dot is 0.16).
    expect(alphaOf(light.edge)).toBeGreaterThanOrEqual(0.5);
    expect(tokensOf(darkBlock).edge).toBeTruthy();
  });

  it('team frames keep a visible border in both themes', () => {
    const alphaOf = (v: string): number => Number(v.match(/rgba\([^)]*,\s*([\d.]+)\)/)?.[1] ?? NaN);
    expect(alphaOf(light['frame-line'])).toBeGreaterThanOrEqual(0.4);
    expect(light['frame-bg']).toBeTruthy();
    const dark = tokensOf(darkBlock);
    expect(dark['frame-line']).toBeTruthy();
    expect(dark['frame-bg']).toBeTruthy();
  });

  it('native controls follow the active theme via color-scheme', () => {
    expect(darkBlock).toContain('color-scheme: dark');
    expect(lightBlock).toContain('color-scheme: light');
  });
});
