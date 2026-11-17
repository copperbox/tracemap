/** Duration of the structural transition (merge/unmerge node flights). */
export const ANIM_MS = 420;

export const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3);
