/** Occasional OTLP metrics export so the collector sees gauge traffic too. */
import { postJson } from './http.js';
import { pick, rand } from './random.js';
import { INFRA_TYPES, SERVICES } from './topology.js';

export async function sendMetricsSample(otlp: string): Promise<void> {
  const svc = pick(SERVICES.filter((s) => !INFRA_TYPES.includes(s.type)));
  const now = BigInt(Date.now()) * 1_000_000n;
  await postJson(otlp, '/v1/metrics', {
    resourceMetrics: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: svc.id } }] },
        scopeMetrics: [
          {
            scope: { name: 'tracemap-sim' },
            metrics: [
              {
                name: 'process.runtime.memory.heap_used',
                unit: 'MiB',
                gauge: { dataPoints: [{ timeUnixNano: now.toString(), asDouble: rand(80, 480) }] },
              },
            ],
          },
        ],
      },
    ],
  });
}
