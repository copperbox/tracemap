import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

interface HoverSyncValue {
  frac: number | null;
  setFrac: (f: number | null) => void;
}

const HoverSyncContext = createContext<HoverSyncValue | null>(null);

/**
 * Wrap a group of charts so hovering any one moves the crosshair on all of
 * them at the same time index. Relies on the grouped charts sharing the same
 * point count / time axis, so a hover fraction maps to the same index across
 * charts. Charts rendered outside a HoverSync keep their own local hover.
 */
export function HoverSync({ children }: { children: ReactNode }) {
  const [frac, setFrac] = useState<number | null>(null);
  const value = useMemo(() => ({ frac, setFrac }), [frac]);
  return <HoverSyncContext.Provider value={value}>{children}</HoverSyncContext.Provider>;
}

/**
 * Shared hover fraction (0-1 across chart width) when inside a HoverSync group,
 * otherwise chart-local state. Same shape as useState so call sites are drop-in.
 */
export function useHoverFrac(): [number | null, (f: number | null) => void] {
  const ctx = useContext(HoverSyncContext);
  const local = useState<number | null>(null);
  return ctx ? [ctx.frac, ctx.setFrac] : local;
}
