import { describe, expect, it } from 'vitest';
import { AliasMap } from './aliases.js';

describe('AliasMap', () => {
  const m = new AliasMap();
  m.set([
    { alias: 'orders-v2', service_id: 'orders' },
    { alias: 'orders_svc', service_id: 'orders' },
    { alias: 'pay', service_id: 'payments' },
  ]);

  it('maps aliases to canonical and leaves other ids alone', () => {
    expect(m.canonical('orders-v2')).toBe('orders');
    expect(m.canonical('orders')).toBe('orders');
    expect(m.canonical('unknown')).toBe('unknown');
  });

  it('expands a canonical id (or one of its aliases) to the whole group', () => {
    expect(m.expand('orders')).toEqual(['orders', 'orders-v2', 'orders_svc']);
    expect(m.expand('orders_svc')).toEqual(['orders', 'orders-v2', 'orders_svc']);
    expect(m.expand('solo')).toEqual(['solo']);
    expect(m.aliasesOf('payments')).toEqual(['pay']);
  });

  it('follows a chain defensively and survives a cycle', () => {
    const c = new AliasMap();
    c.set([
      { alias: 'a', service_id: 'b' },
      { alias: 'b', service_id: 'c' },
    ]);
    expect(c.canonical('a')).toBe('c');
    expect(c.expand('c')).toEqual(['c', 'a', 'b']);
    const loop = new AliasMap();
    loop.set([
      { alias: 'x', service_id: 'y' },
      { alias: 'y', service_id: 'x' },
    ]);
    expect(['x', 'y']).toContain(loop.canonical('x'));
  });

  it('forgets an unmerged alias on reload', () => {
    const r = new AliasMap();
    r.set([{ alias: 'dup', service_id: 'canon' }]);
    r.set([]);
    expect(r.canonical('dup')).toBe('dup');
    expect(r.expand('canon')).toEqual(['canon']);
  });
});
