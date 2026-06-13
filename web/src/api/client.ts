import type {
  ErrorBreakdown,
  ServiceDetail,
  ServiceList,
  Topology,
  TraceDetail,
  TraceListItem,
} from './types';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${path}: ${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  topology: () => get<Topology>('/topology'),
  services: () => get<ServiceList>('/services'),
  serviceDetail: (id: string, from: Date, to: Date) =>
    get<ServiceDetail>(
      `/services/${encodeURIComponent(id)}?from=${from.toISOString()}&to=${to.toISOString()}`,
    ),
  serviceTraces: (id: string, from: Date, to: Date, op?: string) =>
    get<{ traces: TraceListItem[] }>(
      `/services/${encodeURIComponent(id)}/traces?from=${from.toISOString()}&to=${to.toISOString()}` +
        (op ? `&op=${encodeURIComponent(op)}` : ''),
    ),
  trace: (traceId: string) => get<TraceDetail>(`/traces/${encodeURIComponent(traceId)}`),
  health: () => get<{ ok: boolean; spansLastMinute: number }>('/health'),
  serviceSparklines: (id: string) =>
    get<{ points: { t: string; rps: number | null; errPct: number | null; p95: number | null }[] }>(
      `/services/${encodeURIComponent(id)}/sparklines`,
    ),
  edgeSeries: (source: string, target: string) =>
    get<{
      points: { t: string; rps: number | null; errPct: number | null; p95: number | null }[];
      operations: { name: string; share: number }[];
    }>(`/edges/${encodeURIComponent(source)}/${encodeURIComponent(target)}/series`),
  serviceErrors: (id: string, from?: Date, to?: Date) =>
    get<ErrorBreakdown>(
      `/services/${encodeURIComponent(id)}/errors` +
        (from && to ? `?from=${from.toISOString()}&to=${to.toISOString()}` : ''),
    ),
  edgeErrors: (source: string, target: string) =>
    get<ErrorBreakdown>(
      `/edges/${encodeURIComponent(source)}/${encodeURIComponent(target)}/errors`,
    ),
  updateService: (
    id: string,
    patch: {
      displayName?: string | null;
      description?: string | null;
      teamId?: number | null;
      teamName?: string;
      type?: string;
      sloTarget?: number;
    },
  ) => send<{ ok: true }>('PATCH', `/services/${encodeURIComponent(id)}`, patch),
  mergeService: (id: string, sourceId: string) =>
    send<{ ok: true }>('POST', `/services/${encodeURIComponent(id)}/merge`, { sourceId }),
  addDependency: (id: string, targetId: string) =>
    send<{ ok: true }>('POST', `/services/${encodeURIComponent(id)}/dependencies`, { targetId }),
  removeDependency: (id: string, targetId: string) =>
    send<{ ok: true }>(
      'DELETE',
      `/services/${encodeURIComponent(id)}/dependencies/${encodeURIComponent(targetId)}`,
    ),
  createTeam: (name: string) => send<{ id: number; name: string }>('POST', '/teams', { name }),
};
