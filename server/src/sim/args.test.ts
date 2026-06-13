import { describe, expect, it } from 'vitest';
import { argOf, parseSimArgs } from './args.js';

describe('argOf', () => {
  it('returns the value after the flag', () => {
    expect(argOf(['--tps', '12'], 'tps', '6')).toBe('12');
  });

  it('falls back to the default when the flag is missing', () => {
    expect(argOf(['--otlp', 'http://x'], 'tps', '6')).toBe('6');
  });

  it('falls back to the default when the flag has no value', () => {
    expect(argOf(['--tps'], 'tps', '6')).toBe('6');
  });
});

describe('parseSimArgs', () => {
  it('uses built-in defaults with no args and no env', () => {
    const cfg = parseSimArgs([], {});
    expect(cfg).toEqual({
      otlp: 'http://127.0.0.1:4318',
      api: 'http://127.0.0.1:4000',
      tps: 6,
    });
  });

  it('prefers env vars over built-in defaults', () => {
    const cfg = parseSimArgs([], { OTLP_URL: 'http://o:1', API_URL: 'http://a:2', SIM_TPS: '3' });
    expect(cfg).toEqual({ otlp: 'http://o:1', api: 'http://a:2', tps: 3 });
  });

  it('prefers CLI flags over env vars', () => {
    const cfg = parseSimArgs(
      ['--otlp', 'http://cli:1', '--api', 'http://cli:2', '--tps', '24'],
      { OTLP_URL: 'http://env:1', API_URL: 'http://env:2', SIM_TPS: '3' },
    );
    expect(cfg).toEqual({ otlp: 'http://cli:1', api: 'http://cli:2', tps: 24 });
  });

  it('coerces tps to a number', () => {
    expect(parseSimArgs(['--tps', '1.5'], {}).tps).toBe(1.5);
  });
});
