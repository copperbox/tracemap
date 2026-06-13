import { INFRA_TYPES, SERVICES } from './topology.js';

/**
 * Assign teams/types for inferred peers (databases, queues, SaaS APIs) via the
 * management API, like an operator would. Instrumented services do not need
 * this: they declare their owner through the `team.name` resource attribute
 * on their traces.
 */
export async function seedOwnership(api: string): Promise<void> {
  for (const svc of SERVICES.filter((s) => INFRA_TYPES.includes(s.type))) {
    try {
      const res = await fetch(`${api}/api/services/${encodeURIComponent(svc.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ teamName: svc.team, type: svc.type }),
      });
      if (!res.ok && res.status !== 404) console.warn(`seed ${svc.id}: ${res.status}`);
    } catch (err) {
      console.warn(`seed ${svc.id} failed:`, (err as Error).message);
    }
  }
  console.log('Ownership seeded for inferred peers (teams + types).');
}
