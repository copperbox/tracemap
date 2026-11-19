import { useEffect, useState } from 'react';

type PixelRatioWindow = Pick<Window, 'devicePixelRatio' | 'matchMedia'>;

/**
 * Calls `onChange` whenever the device pixel ratio changes (the window moved
 * to another display, or the page zoom changed). A `resolution` media query
 * only fires when leaving the ratio it was built for, so it is rebuilt for
 * the new ratio on every change. Returns the unsubscribe function.
 */
export function watchPixelRatio(win: PixelRatioWindow, onChange: (dpr: number) => void): () => void {
  let mq: MediaQueryList | null = null;
  const listen = (): void => {
    mq = win.matchMedia(`(resolution: ${win.devicePixelRatio || 1}dppx)`);
    mq.addEventListener('change', fire);
  };
  const fire = (): void => {
    mq?.removeEventListener('change', fire);
    listen();
    onChange(win.devicePixelRatio || 1);
  };
  listen();
  return () => mq?.removeEventListener('change', fire);
}

/** The current device pixel ratio, re-rendering when it changes. */
export function usePixelRatio(): number {
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  useEffect(() => {
    setDpr(window.devicePixelRatio || 1);
    return watchPixelRatio(window, setDpr);
  }, []);
  return dpr;
}
