/** Duration of the structural transition (merge/unmerge node flights). */
export const ANIM_MS = 420;

// The CSS transitions in MapView.module.css (.canvasAnimating/.worldAnimating
// move the viewport with a 420ms cubic-bezier(.33,1,.68,1)) must be kept in
// step with this JS easing (which moves the nodes).
export const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3);
