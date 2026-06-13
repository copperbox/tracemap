import { describe, expect, it } from 'vitest';
import { errorFor } from './errors.js';
import { byId } from './topology.js';

const sample = (id: string, n = 100) => Array.from({ length: n }, () => errorFor(byId.get(id)!));

describe('errorFor', () => {
  it('always carries a non-empty exception message', () => {
    for (const id of ['orders-svc', 'pg-orders', 'redis-cart', 'kafka-events', 'elastic-products', 's3-media', 'api.stripe.com']) {
      for (const e of sample(id, 50)) {
        expect(typeof e.attrs['exception.message']).toBe('string');
        expect((e.attrs['exception.message'] as string).length).toBeGreaterThan(0);
      }
    }
  });

  it('returns a 4xx/5xx HTTP status for HTTP services', () => {
    for (const e of sample('orders-svc', 200)) {
      expect(e.httpStatus).not.toBeNull();
      expect(e.httpStatus!).toBeGreaterThanOrEqual(400);
    }
  });

  it('records pg/redis/kafka/elastic failures without an HTTP status', () => {
    for (const id of ['pg-orders', 'redis-cart', 'kafka-events', 'elastic-products']) {
      for (const e of sample(id, 50)) expect(e.httpStatus).toBeNull();
    }
  });

  it('uses provider status codes for external SaaS APIs', () => {
    for (const e of sample('api.stripe.com', 200)) {
      expect(e.httpStatus).not.toBeNull();
      expect([402, 429, 500]).toContain(e.httpStatus);
    }
  });

  it('tags database errors with an exception type', () => {
    for (const e of sample('pg-orders', 50)) {
      expect(typeof e.attrs['exception.type']).toBe('string');
    }
  });
});
