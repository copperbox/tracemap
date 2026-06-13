import { describe, expect, it } from 'vitest';
import { mono, sans } from './font';

describe('mono', () => {
  it('defaults to weight 500', () => {
    expect(mono(9)).toBe("500 9px 'JetBrains Mono', monospace");
  });

  it('accepts an explicit weight', () => {
    expect(mono(8.5, 600)).toBe("600 8.5px 'JetBrains Mono', monospace");
  });
});

describe('sans', () => {
  it('defaults to weight 500', () => {
    expect(sans(13)).toBe("500 13px 'Space Grotesk', system-ui, sans-serif");
  });

  it('accepts an explicit weight', () => {
    expect(sans(22, 700)).toBe("700 22px 'Space Grotesk', system-ui, sans-serif");
  });
});
