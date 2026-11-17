/**
 * Error signatures the scale harness emits. Each entry carries the span
 * attributes the load generator sends and the (code, message) the collector
 * derives from them (api/errorSignature.ts rules), so seeded error rollups and
 * live ones group under the same keys. signatures.test.ts checks the mapping.
 */

export interface Sig {
  /** What errorSignature() returns for these attributes. */
  code: string;
  message: string;
  /** Status recorded on the span; null for non-HTTP failures. */
  httpStatus: number | null;
  attrs: Record<string, string | number>;
  weight: number;
}

const STATUS_TEXT: Record<number, string> = {
  402: 'Payment Required',
  413: 'Payload Too Large',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

/** Exception thrown by the handler: grouped by exception type. */
function exception(type: string, message: string, status: number, weight: number): Sig {
  return {
    code: type,
    message,
    httpStatus: status,
    attrs: { 'exception.type': type, 'exception.message': message, 'error.type': String(status) },
    weight,
  };
}

/** Failure reported as a status with a message: grouped as "HTTP <status>". */
function status(code: number, message: string, weight: number, errorType = String(code)): Sig {
  return {
    code: `HTTP ${code}`,
    message,
    httpStatus: code,
    attrs: { 'exception.message': message, 'error.type': errorType },
    weight,
  };
}

/** Non-HTTP failure (database, queue): grouped by exception type or error.type. */
function plain(code: string, message: string, weight: number, exType?: string): Sig {
  return {
    code: exType ?? code,
    message,
    httpStatus: null,
    attrs: exType
      ? { 'exception.type': exType, 'exception.message': message, 'error.type': code }
      : { 'exception.message': message, 'error.type': code },
    weight,
  };
}

const EXCEPTIONS: Record<string, string[]> = {
  go: ['runtime.Error', 'context.DeadlineExceeded', '*net.OpError'],
  java: ['java.lang.NullPointerException', 'java.net.SocketTimeoutException', 'org.springframework.dao.DataAccessResourceFailureException'],
  nodejs: ['TypeError', 'Error [ERR_SOCKET_CONNECTION_TIMEOUT]', 'UnhandledPromiseRejection'],
  python: ['KeyError', 'requests.exceptions.ConnectionError', 'asyncio.TimeoutError'],
  rust: ['reqwest::Error', 'tokio::time::error::Elapsed'],
  cpp: ['std::runtime_error', 'std::system_error'],
};

/** Two or three signatures for an instrumented service, picked by `pick` (0..1 values). */
export function serviceSigs(lang: string, pick: () => number): Sig[] {
  const ex = EXCEPTIONS[lang] ?? EXCEPTIONS.go;
  const sigs = [
    exception(ex[Math.floor(pick() * ex.length)], 'unhandled error while serving request', 500, 5),
    status(503, 'upstream connect error or disconnect/reset before headers', 3),
  ];
  if (pick() < 0.5) sigs.push(status(504, 'upstream request timeout', 2));
  return sigs;
}

/**
 * What a caller's client span records when its instrumented callee fails with
 * `httpStatus`: the status only, so the signature is "HTTP <status>" with the
 * standard reason phrase.
 */
export function callerSig(httpStatus: number): Sig {
  return {
    code: `HTTP ${httpStatus}`,
    message: STATUS_TEXT[httpStatus] ?? String(httpStatus),
    httpStatus,
    attrs: { 'error.type': String(httpStatus) },
    weight: 1,
  };
}

const PEER_SIGS: Record<string, Sig[]> = {
  postgres: [
    plain('57014', 'canceling statement due to statement timeout', 3, 'QueryCanceledError'),
    plain('53300', 'remaining connection slots are reserved', 2, 'OperationalError'),
    plain('40P01', 'deadlock detected', 1, 'DeadlockDetected'),
  ],
  redis: [
    plain('connection_reset', 'Connection reset by peer', 2, 'ConnectionError'),
    plain('timeout', 'Timeout reading from socket', 2, 'TimeoutError'),
  ],
  kafka: [
    plain('NOT_LEADER_OR_FOLLOWER', 'This server is not the leader for that topic-partition', 2),
    plain('REQUEST_TIMED_OUT', 'The request timed out', 2),
  ],
  elastic: [
    plain('search_phase_execution_exception', 'all shards failed', 2, 'search_phase_execution_exception'),
    plain('es_rejected_execution_exception', 'rejected execution of coordinating operation', 2, 'es_rejected_execution_exception'),
  ],
  s3: [
    status(503, 'Please reduce your request rate', 2, 'SlowDown'),
    status(500, 'We encountered an internal error. Please try again', 1, 'InternalError'),
  ],
};

const SAAS_SIGS: Record<string, Sig[]> = {
  'api.stripe.com': [
    status(402, 'Your card was declined', 3, 'card_declined'),
    status(429, 'Too many requests hit the API too quickly', 2, 'rate_limit'),
    status(500, 'An error occurred on Stripe servers', 1, 'api_error'),
  ],
  'api.twilio.com': [
    status(429, 'Too Many Requests', 2, '20429'),
    status(503, 'Service temporarily unavailable', 1, '20500'),
  ],
};

const GENERIC_SAAS: Sig[] = [
  status(503, 'Service Unavailable', 2),
  status(500, 'Internal Server Error', 1),
  status(429, 'Too Many Requests', 1),
];

/** Signatures a caller sees when an uninstrumented peer fails. */
export function peerSigs(type: string, host: string | null): Sig[] {
  if (type === 'external') return SAAS_SIGS[host ?? ''] ?? GENERIC_SAAS;
  return PEER_SIGS[type] ?? GENERIC_SAAS;
}
