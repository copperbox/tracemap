import { describe, expect, it } from 'vitest';
import { applyKey, MAX_TPS, MIN_TPS, RateControl } from './rate';

describe('RateControl', () => {
  it('starts at the given rate, clamped to the supported range', () => {
    expect(new RateControl(6).tps).toBe(6);
    expect(new RateControl(0).tps).toBe(MIN_TPS);
    expect(new RateControl(10_000).tps).toBe(MAX_TPS);
  });

  it('doubles and halves the rate', () => {
    const r = new RateControl(6);
    r.up();
    expect(r.tps).toBe(12);
    r.down();
    r.down();
    expect(r.tps).toBe(3);
  });

  it('clamps at both ends of the dial', () => {
    const r = new RateControl(MAX_TPS);
    r.up();
    expect(r.tps).toBe(MAX_TPS);
    const s = new RateControl(MIN_TPS);
    s.down();
    expect(s.tps).toBe(MIN_TPS);
  });

  it('intervalMs is the reciprocal of the rate', () => {
    const r = new RateControl(8);
    expect(r.intervalMs()).toBeCloseTo(125);
    r.up();
    expect(r.intervalMs()).toBeCloseTo(62.5);
  });

  it('togglePause flips the paused flag and label reflects it', () => {
    const r = new RateControl(6);
    expect(r.label()).toBe('6 traces/s');
    r.togglePause();
    expect(r.paused).toBe(true);
    expect(r.label()).toBe('paused');
    r.togglePause();
    expect(r.paused).toBe(false);
  });
});

describe('applyKey', () => {
  it('maps + and = to rate up', () => {
    const r = new RateControl(6);
    expect(applyKey(r, '+')).toContain('12');
    expect(applyKey(r, '=')).toContain('24');
  });

  it('maps - and _ to rate down', () => {
    const r = new RateControl(8);
    expect(applyKey(r, '-')).toContain('4');
    expect(applyKey(r, '_')).toContain('2');
  });

  it('maps 0, space and p to pause/resume', () => {
    const r = new RateControl(6);
    expect(applyKey(r, '0')).toContain('paused');
    expect(r.paused).toBe(true);
    expect(applyKey(r, ' ')).toContain('resumed');
    expect(r.paused).toBe(false);
    expect(applyKey(r, 'p')).toContain('paused');
  });

  it('ignores keys it does not handle', () => {
    const r = new RateControl(6);
    expect(applyKey(r, 'x')).toBeNull();
    expect(applyKey(r, 'q')).toBeNull();
    expect(r.tps).toBe(6);
    expect(r.paused).toBe(false);
  });
});
