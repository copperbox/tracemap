import type { FastifyInstance } from 'fastify';
import { serviceDetailRoutes } from './serviceDetail.js';
import { serviceEditRoutes } from './serviceEdit.js';
import { serviceListRoutes } from './serviceList.js';
import { serviceMergeRoutes } from './serviceMerge.js';

/**
 * All /services routes, split by concern:
 *  - serviceList.ts: GET /services (services page listing)
 *  - serviceDetail.ts: GET /services/:id (service page detail)
 *  - serviceEdit.ts: PATCH /services/:id and manual dependency add/remove
 *  - serviceMerge.ts: POST /services/:id/merge
 */
export async function serviceRoutes(app: FastifyInstance): Promise<void> {
  await serviceListRoutes(app);
  await serviceDetailRoutes(app);
  await serviceEditRoutes(app);
  await serviceMergeRoutes(app);
}
