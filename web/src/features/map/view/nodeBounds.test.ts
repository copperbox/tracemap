import { describe, expect, it } from 'vitest';
import { NODE_H, NODE_W } from '../../../lib/layout';
import { nodeCardBounds } from './nodeBounds';

describe('nodeCardBounds', () => {
  it('returns null when there are no points', () => {
    expect(nodeCardBounds([])).toBeNull();
  });

  it('returns null when every point is undefined', () => {
    expect(nodeCardBounds([undefined, undefined])).toBeNull();
  });

  it('bounds a single card including its width and height', () => {
    expect(nodeCardBounds([{ x: 10, y: 20 }])).toEqual({
      x0: 10,
      y0: 20,
      x1: 10 + NODE_W,
      y1: 20 + NODE_H,
    });
  });

  it('spans multiple cards and skips undefined entries', () => {
    expect(nodeCardBounds([{ x: 0, y: 0 }, undefined, { x: 100, y: 50 }])).toEqual({
      x0: 0,
      y0: 0,
      x1: 100 + NODE_W,
      y1: 50 + NODE_H,
    });
  });

  it('handles negative coordinates', () => {
    expect(nodeCardBounds([{ x: -30, y: -40 }, { x: 5, y: 5 }])).toEqual({
      x0: -30,
      y0: -40,
      x1: 5 + NODE_W,
      y1: 5 + NODE_H,
    });
  });
});
