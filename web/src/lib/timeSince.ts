/** Coarse human-readable age of an ISO timestamp ("3 days ago", "5h ago", "today"). */
export function timeSince(iso: string): string {
  const days = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000));
  if (days >= 1) return `${days} day${days === 1 ? '' : 's'} ago`;
  const hours = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 3_600_000));
  if (hours >= 1) return `${hours}h ago`;
  return 'today';
}
