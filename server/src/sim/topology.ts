/**
 * Demo topology for the simulator: the 40-service e-commerce system from the
 * design handoff, replayed as genuine OTLP traffic.
 */

export type SimType =
  | 'postgres'
  | 'redis'
  | 'kafka'
  | 'elastic'
  | 's3'
  | 'external'
  | 'service'
  | 'bff'
  | 'gateway';

export interface SimService {
  id: string;
  type: SimType;
  team: string;
  /** telemetry.sdk.language for instrumented services; host for external SaaS. */
  lang?: string;
  host?: string;
  ops: string[];
}

export const INFRA_TYPES: SimType[] = ['postgres', 'redis', 'kafka', 'elastic', 's3', 'external'];

export const SERVICES: SimService[] = [
  { id: 'pg-orders', type: 'postgres', team: 'Checkout', ops: ['SELECT orders', 'INSERT order_items', 'UPDATE orders SET status'] },
  { id: 'pg-users', type: 'postgres', team: 'Identity', ops: ['SELECT users', 'UPDATE users', 'SELECT addresses'] },
  { id: 'pg-catalog', type: 'postgres', team: 'Catalog', ops: ['SELECT products', 'SELECT variants', 'SELECT categories'] },
  { id: 'pg-payments', type: 'postgres', team: 'Payments', ops: ['INSERT payments', 'SELECT payment_methods', 'UPDATE ledger'] },
  { id: 'pg-inventory', type: 'postgres', team: 'Fulfillment', ops: ['SELECT stock_levels', 'UPDATE reservations'] },
  { id: 'redis-cart', type: 'redis', team: 'Storefront', ops: ['GET cart:{uid}', 'SETEX cart:{uid}', 'HGETALL cart'] },
  { id: 'redis-sessions', type: 'redis', team: 'Identity', ops: ['GET sess:{sid}', 'SETEX sess:{sid}'] },
  { id: 'redis-catalog', type: 'redis', team: 'Catalog', ops: ['MGET product:*', 'SETEX product:{id}'] },
  { id: 'kafka-events', type: 'kafka', team: 'Platform', ops: ['checkout.completed', 'stock.changed', 'notify.queued'] },
  { id: 'elastic-products', type: 'elastic', team: 'Catalog', ops: ['search products', 'msearch suggest'] },
  { id: 's3-media', type: 's3', team: 'Catalog', ops: ['GetObject', 'PutObject'] },
  { id: 'api.stripe.com', type: 'external', team: 'Payments', host: 'api.stripe.com', ops: ['POST /v1/payment_intents', 'POST /v1/refunds'] },
  { id: 'api.sendgrid.com', type: 'external', team: 'Growth', host: 'api.sendgrid.com', ops: ['POST /v3/mail/send'] },
  { id: 'api.twilio.com', type: 'external', team: 'Growth', host: 'api.twilio.com', ops: ['POST /2010-04-01/Messages'] },
  { id: 'api.easypost.com', type: 'external', team: 'Fulfillment', host: 'api.easypost.com', ops: ['POST /v2/rates', 'POST /v2/shipments'] },
  { id: 'api.taxjar.com', type: 'external', team: 'Checkout', host: 'api.taxjar.com', ops: ['POST /v2/taxes'] },

  { id: 'orders-svc', type: 'service', team: 'Checkout', lang: 'go', ops: ['GET /v1/orders/{id}', 'POST /v1/orders', 'GET /v1/orders'] },
  { id: 'users-svc', type: 'service', team: 'Identity', lang: 'go', ops: ['GET /v1/users/{id}', 'PATCH /v1/users/{id}'] },
  { id: 'catalog-svc', type: 'service', team: 'Catalog', lang: 'java', ops: ['GET /v1/products/{id}', 'GET /v1/products', 'GET /v1/variants'] },
  { id: 'inventory-svc', type: 'service', team: 'Fulfillment', lang: 'go', ops: ['GET /v1/stock/{sku}', 'POST /v1/reservations'] },
  { id: 'payments-svc', type: 'service', team: 'Payments', lang: 'java', ops: ['POST /v1/intents', 'POST /v1/capture', 'POST /v1/refunds'] },
  { id: 'shipping-svc', type: 'service', team: 'Fulfillment', lang: 'nodejs', ops: ['POST /v1/rates', 'POST /v1/labels'] },
  { id: 'tax-svc', type: 'service', team: 'Checkout', lang: 'nodejs', ops: ['POST /v1/quote'] },
  { id: 'media-svc', type: 'service', team: 'Catalog', lang: 'rust', ops: ['GET /img/{id}', 'POST /v1/upload'] },
  { id: 'promo-svc', type: 'service', team: 'Growth', lang: 'nodejs', ops: ['POST /v1/apply', 'GET /v1/campaigns'] },
  { id: 'notif-svc', type: 'service', team: 'Growth', lang: 'python', ops: ['POST /v1/notify', 'POST /v1/digest'] },
  { id: 'analytics-svc', type: 'service', team: 'Data', lang: 'python', ops: ['POST /v1/track', 'GET /v1/funnels'] },
  { id: 'reviews-svc', type: 'service', team: 'Catalog', lang: 'python', ops: ['GET /v1/reviews', 'POST /v1/reviews'] },
  { id: 'auth-svc', type: 'service', team: 'Identity', lang: 'go', ops: ['POST /v1/token', 'GET /v1/verify', 'POST /v1/refresh'] },
  { id: 'pricing-svc', type: 'service', team: 'Catalog', lang: 'java', ops: ['POST /v1/quote', 'GET /v1/prices/{sku}'] },
  { id: 'search-svc', type: 'service', team: 'Catalog', lang: 'java', ops: ['GET /v1/search', 'GET /v1/suggest'] },
  { id: 'fraud-svc', type: 'service', team: 'Payments', lang: 'python', ops: ['POST /v1/score'] },
  { id: 'recs-svc', type: 'service', team: 'Data', lang: 'python', ops: ['GET /v1/recommendations', 'POST /v1/feedback'] },
  { id: 'cart-svc', type: 'service', team: 'Storefront', lang: 'go', ops: ['GET /v1/cart', 'POST /v1/cart/items', 'DELETE /v1/cart/items/{id}'] },
  { id: 'account-svc', type: 'service', team: 'Identity', lang: 'nodejs', ops: ['GET /v1/me', 'GET /v1/me/orders'] },
  { id: 'checkout-svc', type: 'service', team: 'Checkout', lang: 'go', ops: ['POST /v1/checkout', 'POST /v1/confirm'] },
  { id: 'storefront-bff', type: 'bff', team: 'Storefront', lang: 'nodejs', ops: ['GET /home', 'GET /product/{slug}', 'GET /search'] },
  { id: 'admin-bff', type: 'bff', team: 'Platform', lang: 'nodejs', ops: ['GET /admin/orders', 'GET /admin/inventory'] },
  { id: 'checkout-bff', type: 'bff', team: 'Checkout', lang: 'nodejs', ops: ['POST /checkout/start', 'POST /checkout/pay'] },
  { id: 'api-gateway', type: 'gateway', team: 'Platform', lang: 'cpp', ops: ['route /storefront', 'route /checkout', 'route /admin', 'route /account'] },
];

export const DEPS: Record<string, string[]> = {
  'orders-svc': ['pg-orders', 'kafka-events'],
  'users-svc': ['pg-users'],
  'catalog-svc': ['pg-catalog', 'redis-catalog'],
  'inventory-svc': ['pg-inventory', 'kafka-events'],
  'payments-svc': ['pg-payments', 'api.stripe.com', 'kafka-events'],
  'shipping-svc': ['api.easypost.com', 'kafka-events'],
  'tax-svc': ['api.taxjar.com'],
  'media-svc': ['s3-media'],
  'promo-svc': ['pg-catalog'],
  'notif-svc': ['api.sendgrid.com', 'api.twilio.com', 'kafka-events'],
  'analytics-svc': ['kafka-events', 'elastic-products'],
  'reviews-svc': ['pg-catalog', 'kafka-events'],
  'auth-svc': ['users-svc', 'redis-sessions'],
  'pricing-svc': ['catalog-svc', 'redis-catalog'],
  'search-svc': ['elastic-products', 'catalog-svc'],
  'fraud-svc': ['users-svc', 'kafka-events'],
  'recs-svc': ['catalog-svc', 'kafka-events', 'redis-catalog'],
  'cart-svc': ['redis-cart', 'pricing-svc', 'inventory-svc'],
  'account-svc': ['users-svc', 'orders-svc', 'auth-svc', 'notif-svc'],
  'checkout-svc': ['cart-svc', 'orders-svc', 'payments-svc', 'shipping-svc', 'tax-svc', 'fraud-svc', 'promo-svc', 'inventory-svc'],
  'storefront-bff': ['catalog-svc', 'search-svc', 'cart-svc', 'recs-svc', 'reviews-svc', 'media-svc', 'auth-svc'],
  'checkout-bff': ['checkout-svc', 'auth-svc', 'cart-svc'],
  'admin-bff': ['orders-svc', 'catalog-svc', 'inventory-svc', 'users-svc', 'analytics-svc', 'auth-svc'],
  'api-gateway': ['storefront-bff', 'checkout-bff', 'admin-bff', 'account-svc', 'auth-svc'],
};

/** Incident narrative: error rates per service (fraction of requests). */
export const ERROR_RATE: Record<string, number> = {
  'search-svc': 0.045,
  'payments-svc': 0.014,
  'api.stripe.com': 0.013,
  'inventory-svc': 0.012,
};
export const DEFAULT_ERROR_RATE = 0.002;

/** Base self-latency (ms) per type before adding child time. */
export const BASE_LATENCY: Record<SimType, [number, number]> = {
  postgres: [4, 12],
  redis: [0.8, 3],
  kafka: [3, 8],
  elastic: [22, 60],
  s3: [35, 90],
  external: [120, 380],
  service: [8, 35],
  bff: [6, 25],
  gateway: [2, 8],
};

export const LATENCY_MULTIPLIER: Record<string, number> = {
  'search-svc': 3.2,
  'payments-svc': 2.0,
  'api.stripe.com': 2.2,
  'inventory-svc': 1.6,
};

export const byId = new Map(SERVICES.map((s) => [s.id, s]));
