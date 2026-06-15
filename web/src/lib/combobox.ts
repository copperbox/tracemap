/**
 * Shared option model + search for the <Combobox> dropdown. Keeping the
 * filtering here (rather than in the component) lets the team filter and the
 * merge-service picker search identically, and keeps it unit-testable.
 */
export interface ComboOption<V> {
  label: string;
  value: V;
}

/** Narrow options to those whose label contains `query` (case-insensitive).
 *  An empty/whitespace query returns the list unchanged. */
export function filterOptions<V>(options: ComboOption<V>[], query: string): ComboOption<V>[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  return options.filter((o) => o.label.toLowerCase().includes(q));
}
