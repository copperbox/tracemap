/**
 * Realistic error detail for simulated failing spans.
 *
 * When a span errors, the simulator attaches OTEL-style error attributes so the
 * collector stores -- and the inspector drawer can surface -- the actual errors
 * being seen, not a uniform "HTTP 500". Each service type fails the way that
 * kind of system really fails: HTTP services throw exceptions or return 5xx,
 * databases time out / deadlock, queues reject, SaaS APIs return their own
 * status codes. The server derives a grouping signature from these attributes
 * (see api/errorSignature.ts).
 */
import { pick } from './random.js';
import type { SimService } from './topology.js';

export interface SpanError {
  /** Merged into the span's attributes. */
  attrs: Record<string, string | number>;
  /** HTTP status to record (overrides the span's default); null for non-HTTP errors. */
  httpStatus: number | null;
}

interface Weighted {
  weight: number;
  error: SpanError;
}

function weighted(items: Weighted[]): SpanError {
  const total = items.reduce((a, i) => a + i.weight, 0);
  let r = Math.random() * total;
  for (const i of items) {
    if ((r -= i.weight) <= 0) return i.error;
  }
  return items[items.length - 1].error;
}

// ---- HTTP services / BFFs / gateways ----

/** Unhandled-exception types keyed by the service's runtime language. */
const HTTP_EXCEPTIONS: Record<string, string[]> = {
  go: ['runtime.Error', 'context.DeadlineExceeded', '*net.OpError'],
  java: [
    'java.lang.NullPointerException',
    'java.net.SocketTimeoutException',
    'org.springframework.dao.DataAccessResourceFailureException',
  ],
  nodejs: ['TypeError', 'Error [ERR_SOCKET_CONNECTION_TIMEOUT]', 'UnhandledPromiseRejection'],
  python: ['KeyError', 'requests.exceptions.ConnectionError', 'asyncio.TimeoutError'],
  rust: ['reqwest::Error', 'tokio::time::error::Elapsed'],
  cpp: ['std::runtime_error', 'std::system_error'],
};

function httpError(lang: string | undefined): SpanError {
  const excepts = HTTP_EXCEPTIONS[lang ?? ''] ?? HTTP_EXCEPTIONS.go;
  return weighted([
    {
      weight: 5,
      error: {
        httpStatus: 500,
        attrs: {
          'exception.type': pick(excepts),
          'exception.message': 'unhandled error while serving request',
          'error.type': '500',
        },
      },
    },
    {
      weight: 3,
      error: {
        httpStatus: 503,
        attrs: {
          'exception.message': 'upstream connect error or disconnect/reset before headers',
          'error.type': '503',
        },
      },
    },
    {
      weight: 2,
      error: {
        httpStatus: 504,
        attrs: { 'exception.message': 'upstream request timeout', 'error.type': '504' },
      },
    },
    {
      weight: 1,
      error: {
        httpStatus: 502,
        attrs: { 'exception.message': 'bad gateway: connection refused', 'error.type': '502' },
      },
    },
    {
      weight: 1,
      error: {
        httpStatus: 429,
        attrs: { 'exception.message': 'rate limit exceeded', 'error.type': 'rate_limited' },
      },
    },
  ]);
}

// ---- infrastructure dependencies ----

const PG_ERRORS: Weighted[] = [
  { weight: 3, error: { httpStatus: null, attrs: { 'exception.type': 'QueryCanceledError', 'exception.message': 'canceling statement due to statement timeout', 'error.type': '57014' } } },
  { weight: 2, error: { httpStatus: null, attrs: { 'exception.type': 'OperationalError', 'exception.message': 'remaining connection slots are reserved', 'error.type': '53300' } } },
  { weight: 1, error: { httpStatus: null, attrs: { 'exception.type': 'DeadlockDetected', 'exception.message': 'deadlock detected', 'error.type': '40P01' } } },
  { weight: 1, error: { httpStatus: null, attrs: { 'exception.type': 'SerializationFailure', 'exception.message': 'could not serialize access due to concurrent update', 'error.type': '40001' } } },
];

const REDIS_ERRORS: Weighted[] = [
  { weight: 2, error: { httpStatus: null, attrs: { 'exception.type': 'ConnectionError', 'exception.message': 'Connection reset by peer', 'error.type': 'connection_reset' } } },
  { weight: 2, error: { httpStatus: null, attrs: { 'exception.type': 'TimeoutError', 'exception.message': 'Timeout reading from socket', 'error.type': 'timeout' } } },
  { weight: 1, error: { httpStatus: null, attrs: { 'exception.type': 'ReadOnlyError', 'exception.message': "READONLY You can't write against a read only replica", 'error.type': 'readonly' } } },
];

const KAFKA_ERRORS: Weighted[] = [
  { weight: 2, error: { httpStatus: null, attrs: { 'exception.message': 'This server is not the leader for that topic-partition', 'error.type': 'NOT_LEADER_OR_FOLLOWER' } } },
  { weight: 2, error: { httpStatus: null, attrs: { 'exception.message': 'The request timed out', 'error.type': 'REQUEST_TIMED_OUT' } } },
  { weight: 1, error: { httpStatus: null, attrs: { 'exception.message': 'Messages rejected: fewer in-sync replicas than required', 'error.type': 'NOT_ENOUGH_REPLICAS' } } },
];

const ELASTIC_ERRORS: Weighted[] = [
  { weight: 2, error: { httpStatus: null, attrs: { 'exception.type': 'search_phase_execution_exception', 'exception.message': 'all shards failed', 'error.type': 'search_phase_execution_exception' } } },
  { weight: 2, error: { httpStatus: null, attrs: { 'exception.type': 'es_rejected_execution_exception', 'exception.message': 'rejected execution of coordinating operation', 'error.type': 'es_rejected_execution_exception' } } },
  { weight: 1, error: { httpStatus: null, attrs: { 'exception.type': 'circuit_breaking_exception', 'exception.message': '[parent] Data too large', 'error.type': 'circuit_breaking_exception' } } },
];

const S3_ERRORS: Weighted[] = [
  { weight: 2, error: { httpStatus: 503, attrs: { 'exception.message': 'Please reduce your request rate', 'error.type': 'SlowDown' } } },
  { weight: 1, error: { httpStatus: 500, attrs: { 'exception.message': 'We encountered an internal error. Please try again', 'error.type': 'InternalError' } } },
  { weight: 1, error: { httpStatus: 503, attrs: { 'exception.message': 'Service is unable to handle request', 'error.type': 'ServiceUnavailable' } } },
];

/** SaaS APIs return their own status codes and provider error codes. */
const EXTERNAL_ERRORS: Record<string, Weighted[]> = {
  'api.stripe.com': [
    { weight: 3, error: { httpStatus: 402, attrs: { 'exception.message': 'Your card was declined', 'error.type': 'card_declined' } } },
    { weight: 2, error: { httpStatus: 429, attrs: { 'exception.message': 'Too many requests hit the API too quickly', 'error.type': 'rate_limit' } } },
    { weight: 1, error: { httpStatus: 500, attrs: { 'exception.message': 'An error occurred on Stripe servers', 'error.type': 'api_error' } } },
  ],
  'api.sendgrid.com': [
    { weight: 2, error: { httpStatus: 429, attrs: { 'exception.message': 'too many requests', 'error.type': 'rate_limit' } } },
    { weight: 1, error: { httpStatus: 413, attrs: { 'exception.message': 'payload too large', 'error.type': 'payload_too_large' } } },
    { weight: 1, error: { httpStatus: 500, attrs: { 'exception.message': 'internal server error', 'error.type': 'server_error' } } },
  ],
  'api.twilio.com': [
    { weight: 2, error: { httpStatus: 429, attrs: { 'exception.message': 'Too Many Requests', 'error.type': '20429' } } },
    { weight: 1, error: { httpStatus: 503, attrs: { 'exception.message': 'Service temporarily unavailable', 'error.type': '20500' } } },
    { weight: 1, error: { httpStatus: 500, attrs: { 'exception.message': 'Internal Server Error', 'error.type': '20500' } } },
  ],
  'api.easypost.com': [
    { weight: 2, error: { httpStatus: 422, attrs: { 'exception.message': 'Unable to retrieve rates for the given address', 'error.type': 'RATE.UNAVAILABLE' } } },
    { weight: 1, error: { httpStatus: 429, attrs: { 'exception.message': 'Rate limit exceeded', 'error.type': 'RATE_LIMITED' } } },
    { weight: 1, error: { httpStatus: 500, attrs: { 'exception.message': 'Internal server error', 'error.type': 'INTERNAL' } } },
  ],
  'api.taxjar.com': [
    { weight: 2, error: { httpStatus: 422, attrs: { 'exception.message': 'to_zip is not a valid postal code', 'error.type': 'unprocessable_entity' } } },
    { weight: 1, error: { httpStatus: 429, attrs: { 'exception.message': 'Rate limit exceeded', 'error.type': 'rate_limited' } } },
    { weight: 1, error: { httpStatus: 500, attrs: { 'exception.message': 'internal server error', 'error.type': 'server_error' } } },
  ],
};

const GENERIC_EXTERNAL: Weighted[] = [
  { weight: 2, error: { httpStatus: 503, attrs: { 'exception.message': 'Service Unavailable', 'error.type': '503' } } },
  { weight: 1, error: { httpStatus: 500, attrs: { 'exception.message': 'Internal Server Error', 'error.type': '500' } } },
  { weight: 1, error: { httpStatus: 429, attrs: { 'exception.message': 'Too Many Requests', 'error.type': '429' } } },
];

/** Build realistic error attributes for a failing span on `svc`. */
export function errorFor(svc: SimService): SpanError {
  switch (svc.type) {
    case 'service':
    case 'bff':
    case 'gateway':
      return httpError(svc.lang);
    case 'postgres':
      return weighted(PG_ERRORS);
    case 'redis':
      return weighted(REDIS_ERRORS);
    case 'kafka':
      return weighted(KAFKA_ERRORS);
    case 'elastic':
      return weighted(ELASTIC_ERRORS);
    case 's3':
      return weighted(S3_ERRORS);
    case 'external':
      return weighted(EXTERNAL_ERRORS[svc.id] ?? GENERIC_EXTERNAL);
  }
}
