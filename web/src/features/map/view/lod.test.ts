import { describe, expect, it } from 'vitest';
import { CARD_EXIT_K, CARD_MIN_K, SMALL_GRAPH_NODES, canvasLabelsOn, cardsCompact, chooseLod } from './lod';

describe('chooseLod', () => {
  const big = SMALL_GRAPH_NODES + 1;

  it('mounts cards at every zoom for a small graph', () => {
    expect(chooseLod(0.05, SMALL_GRAPH_NODES, 'canvas')).toBe('cards');
  });

  it('draws a large graph on the canvas below the card zoom', () => {
    expect(chooseLod(CARD_MIN_K - 0.01, big, 'canvas')).toBe('canvas');
    expect(chooseLod(CARD_MIN_K, big, 'canvas')).toBe('cards');
  });

  it('holds the current level inside the hysteresis band', () => {
    const k = (CARD_MIN_K + CARD_EXIT_K) / 2;
    expect(chooseLod(k, big, 'canvas')).toBe('canvas');
    expect(chooseLod(k, big, 'cards')).toBe('cards');
  });

  it('drops back to the canvas below the exit zoom', () => {
    expect(chooseLod(CARD_EXIT_K - 0.01, big, 'cards')).toBe('canvas');
  });
});

describe('cardsCompact', () => {
  it('hides card text below the label zoom', () => {
    expect(cardsCompact(0.4, 0.5, false)).toBe(true);
    expect(cardsCompact(0.5, 0.5, false)).toBe(false);
  });

  it('never hides text while isolated', () => {
    expect(cardsCompact(0.1, 0.5, true)).toBe(false);
  });
});

describe('canvasLabelsOn', () => {
  it('follows the label zoom preference', () => {
    expect(canvasLabelsOn(0.4, 0.5, false)).toBe(false);
    expect(canvasLabelsOn(0.4, 0.3, false)).toBe(true);
  });

  it('skips text too small to read even when labels are always on', () => {
    expect(canvasLabelsOn(0.1, 0, false)).toBe(false);
    expect(canvasLabelsOn(0.3, 0, false)).toBe(true);
  });

  it('shows labels while isolated whenever they are legible', () => {
    expect(canvasLabelsOn(0.3, 0.5, true)).toBe(true);
  });
});
