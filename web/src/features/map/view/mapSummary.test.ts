import { describe, expect, it } from 'vitest';
import type { Status, TopologyService } from '../../../api/types';
import { mapSummary } from './mapSummary';

const svc = (status: Status): TopologyService => ({ status }) as TopologyService;

describe('mapSummary', () => {
  it('counts services by health', () => {
    const list = [...Array(4998)].map(() => svc('ok')).concat([svc('warn'), svc('crit')]);
    expect(mapSummary([...list, svc('warn')], true)).toBe(
      'Service map overview: 5,001 services, 1 critical, 2 degraded. Zoom in to reach individual services, or use the Services table for a full list.',
    );
  });
  it('drops the zoom hint once cards are mounted', () => {
    expect(mapSummary([svc('ok')], false)).toBe('Service map: 1 service, 0 critical, 0 degraded.');
  });
});
