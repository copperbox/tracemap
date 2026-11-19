import type { TopologyService } from '../../../api/types';

const n = (v: number): string => v.toLocaleString('en-US');

/**
 * Screen-reader label for the canvas overview, which draws every service as
 * pixels: how many services there are and how many are unhealthy.
 */
export function mapSummary(services: readonly TopologyService[], overview: boolean): string {
  let warn = 0;
  let crit = 0;
  for (const s of services) {
    if (s.status === 'warn') warn++;
    else if (s.status === 'crit') crit++;
  }
  const counts = `${n(services.length)} ${services.length === 1 ? 'service' : 'services'}, ${n(crit)} critical, ${n(warn)} degraded`;
  return overview
    ? `Service map overview: ${counts}. Zoom in to reach individual services, or use the Services table for a full list.`
    : `Service map: ${counts}.`;
}
