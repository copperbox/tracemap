import { describe, expect, it } from 'vitest';
import { errLevel } from './errLevel';

describe('errLevel', () => {
  it('treats missing values as ok', () => {
    expect(errLevel(null)).toBe('ok');
    expect(errLevel(undefined)).toBe('ok');
  });

  it('is ok at or below 0.8', () => {
    expect(errLevel(0)).toBe('ok');
    expect(errLevel(0.8)).toBe('ok');
  });

  it('is warn above 0.8 up to 2', () => {
    expect(errLevel(0.81)).toBe('warn');
    expect(errLevel(2)).toBe('warn');
  });

  it('is crit above 2', () => {
    expect(errLevel(2.01)).toBe('crit');
    expect(errLevel(15)).toBe('crit');
  });
});
