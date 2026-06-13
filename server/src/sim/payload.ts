/**
 * OTLP/JSON encoding: turns the simulator's in-memory spans into the exact
 * `POST /v1/traces` export payload an OpenTelemetry SDK would send.
 */
import { byId } from './topology.js';
import type { SimSpan } from './trace.js';

export function toAnyValue(v: string | number): Record<string, unknown> {
  return typeof v === 'number'
    ? Number.isInteger(v)
      ? { intValue: String(v) }
      : { doubleValue: v }
    : { stringValue: v };
}

export function exportPayload(traceId: string, spans: SimSpan[]): unknown {
  const byService = new Map<string, SimSpan[]>();
  for (const s of spans) {
    const arr = byService.get(s.service.id) ?? [];
    arr.push(s);
    byService.set(s.service.id, arr);
  }
  return {
    resourceSpans: [...byService.entries()].map(([svcId, svcSpans]) => {
      const svc = byId.get(svcId)!;
      return {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: svcId } },
            { key: 'team.name', value: { stringValue: svc.team } },
            { key: 'telemetry.sdk.language', value: { stringValue: svc.lang ?? 'unknown' } },
            { key: 'telemetry.sdk.name', value: { stringValue: 'opentelemetry' } },
            { key: 'telemetry.sdk.version', value: { stringValue: '1.30.0' } },
            { key: 'cloud.region', value: { stringValue: 'us-east-1' } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: 'tracemap-sim', version: '1.0.0' },
            spans: svcSpans.map((s) => ({
              traceId,
              spanId: s.spanId,
              parentSpanId: s.parentSpanId ?? undefined,
              name: s.name,
              kind: s.kind,
              startTimeUnixNano: s.startNs.toString(),
              endTimeUnixNano: s.endNs.toString(),
              attributes: Object.entries(s.attrs).map(([key, value]) => ({ key, value: toAnyValue(value) })),
              status: s.isError ? { code: 2, message: 'simulated failure' } : { code: 0 },
            })),
          },
        ],
      };
    }),
  };
}
