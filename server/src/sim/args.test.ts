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
      services: 0,
      teams: 0,
      unassigned: 0,
      dupRatio: 0.4,
    });
  });

  it('prefers env vars over built-in defaults', () => {
    const cfg = parseSimArgs([], {
      OTLP_URL: 'http://o:1',
      API_URL: 'http://a:2',
      SIM_TPS: '3',
      SIM_SERVICES: '250',
      SIM_TEAMS: '8',
      SIM_UNASSIGNED: '30',
      SIM_DUP_RATIO: '0.5',
    });
    expect(cfg).toEqual({
      otlp: 'http://o:1',
      api: 'http://a:2',
      tps: 3,
      services: 250,
      teams: 8,
      unassigned: 30,
      dupRatio: 0.5,
    });
  });

  it('prefers CLI flags over env vars', () => {
    const cfg = parseSimArgs(
      ['--otlp', 'http://cli:1', '--api', 'http://cli:2', '--tps', '24', '--services', '300'],
      { OTLP_URL: 'http://env:1', API_URL: 'http://env:2', SIM_TPS: '3', SIM_SERVICES: '100' },
    );
    expect(cfg).toMatchObject({ otlp: 'http://cli:1', api: 'http://cli:2', tps: 24, services: 300 });
  });

  it('coerces numeric flags to numbers', () => {
    const cfg = parseSimArgs(['--tps', '1.5', '--unassigned', '40', '--dup-ratio', '0.25'], {});
    expect(cfg.tps).toBe(1.5);
    expect(cfg.unassigned).toBe(40);
    expect(cfg.dupRatio).toBe(0.25);
  });
});
