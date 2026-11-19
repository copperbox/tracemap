import { describe, expect, it } from 'vitest';
import { ArgError, parseArgs, parseDuration } from './args.js';

describe('parseDuration', () => {
  it('reads seconds, minutes and hours', () => {
    expect(parseDuration('90')).toBe(90);
    expect(parseDuration('90s')).toBe(90);
    expect(parseDuration('5m')).toBe(300);
    expect(parseDuration('1.5h')).toBe(5400);
    expect(() => parseDuration('soon')).toThrow(ArgError);
  });
});

describe('parseArgs', () => {
  it('fills defaults per command', () => {
    const { command, opts } = parseArgs(['load'], {});
    expect(command).toBe('load');
    expect(opts).toMatchObject({ services: 5000, teams: 0, 'topology-seed': 1, rate: 20000, duration: 0, connections: 8, batch: 1000, incident: null });
    expect(parseArgs(['seed'], {}).opts).toMatchObject({ days: 7, db: null, reset: false, yes: false, compress: true });
  });

  it('parses values, = syntax, durations and booleans', () => {
    const { opts } = parseArgs(['load', '--rate', '5000', '--duration=3m', '--gzip', '--incident', 'a-svc'], {});
    expect(opts).toMatchObject({ rate: 5000, duration: 180, gzip: true, incident: 'a-svc' });
    expect(parseArgs(['seed', '--compress=false'], {}).opts.compress).toBe(false);
  });

  it('takes the database and URLs from the environment, flags win', () => {
    expect(parseArgs(['seed'], { DATABASE_URL: 'postgres://x/y' }).opts.db).toBe('postgres://x/y');
    expect(parseArgs(['seed', '--db', 'postgres://a/b'], { DATABASE_URL: 'postgres://x/y' }).opts.db).toBe('postgres://a/b');
    expect(parseArgs(['probe'], { API_URL: 'http://h:1' }).opts.api).toBe('http://h:1');
  });

  it('merges every flag for all', () => {
    const { opts } = parseArgs(['all', '--no-seed', '--probe-every', '30s', '--days', '3', '--api', 'http://h'], {});
    expect(opts).toMatchObject({ 'no-seed': true, 'probe-every': 30, days: 3, api: 'http://h', rate: 20000 });
  });

  it('rejects unknown commands, unknown flags, bad numbers and missing values', () => {
    expect(() => parseArgs([], {})).toThrow(ArgError);
    expect(() => parseArgs(['seeed'], {})).toThrow(/unknown command/);
    expect(() => parseArgs(['seed', '--rate5'], {})).toThrow(/unknown flag/);
    expect(() => parseArgs(['probe', '--rate', '5'], {})).toThrow(/unknown flag --rate/);
    expect(() => parseArgs(['load', '--rate', 'fast'], {})).toThrow(/number/);
    expect(() => parseArgs(['load', '--rate'], {})).toThrow(/needs a value/);
    expect(() => parseArgs(['load', 'extra'], {})).toThrow(/unexpected/);
  });
});
