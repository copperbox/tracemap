/** Shared randomness helpers for the simulator. */

export const rand = (a: number, b: number) => a + Math.random() * (b - a);

export const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

export const hex = (n: number) => {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
};
