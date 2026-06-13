/**
 * localStorage persistence for user-pinned node positions (dragging a node on
 * the map overrides the auto-layout; "reset layout" clears the pins).
 */

export type NodePositions = Record<string, { x: number; y: number }>;

const POSITIONS_KEY = 'tracemap.nodePositions';

export function loadPinnedPositions(): NodePositions {
  try {
    return JSON.parse(localStorage.getItem(POSITIONS_KEY) ?? '{}') as NodePositions;
  } catch {
    return {};
  }
}

export function savePinnedPositions(positions: NodePositions): void {
  localStorage.setItem(POSITIONS_KEY, JSON.stringify(positions));
}

export function clearPinnedPositions(): void {
  localStorage.removeItem(POSITIONS_KEY);
}
