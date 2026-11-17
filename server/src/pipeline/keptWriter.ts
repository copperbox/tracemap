import type pg from 'pg';
import { hexToUuid, spanWordsToBigint } from '../rollup/schema.js';
import type { KeptSink, KeptSpanRow, KeptTrace } from './traceBuffer.js';

export interface KeptWriterStats {
  queuedTraces: number;
  queuedSpans: number;
  writtenTraces: number;
  writtenSpans: number;
  /** Late spans refused because the queue was full. */
  droppedLateSpans: number;
  /** Batches given up after repeated write failures. */
  abandonedBatches: number;
  abandonedSpans: number;
  lastWriteMs: number;
}

const MAX_ATTEMPTS = 3;

/** jsonb rejects \u0000 and text rejects NUL; drop them rather than fail a whole batch. */
function cleanJson(s: string): string {
  return s.includes('\\u0000') ? s.replace(/\\u0000/g, '') : s;
}

/**
 * Bounded queue of kept traces, written in the background. When the queue is
 * full, new keeps are refused (TraceBuffer counts them as dropped). A batch
 * that keeps failing is abandoned after a few attempts so one bad row cannot
 * wedge the writer.
 */
export class KeptWriter implements KeptSink {
  private traces: KeptTrace[] = [];
  private late: KeptSpanRow[] = [];
  private queued = 0;
  private attempts = 0;
  private s = {
    writtenTraces: 0,
    writtenSpans: 0,
    droppedLateSpans: 0,
    abandonedBatches: 0,
    abandonedSpans: 0,
    lastWriteMs: 0,
  };

  constructor(
    private readonly pool: pg.Pool,
    private readonly maxQueuedSpans: number,
    private readonly batchSpans = 20_000,
  ) {}

  hasRoom(spans: number): boolean {
    return this.queued + spans <= this.maxQueuedSpans;
  }

  offer(trace: KeptTrace): void {
    this.traces.push(trace);
    this.queued += trace.spans.length;
  }

  offerLate(span: KeptSpanRow): boolean {
    if (!this.hasRoom(1)) {
      this.s.droppedLateSpans++;
      return false;
    }
    this.late.push(span);
    this.queued++;
    return true;
  }

  get queuedSpans(): number {
    return this.queued;
  }

  /** Write everything queued, in batches. */
  async drain(): Promise<void> {
    while (this.traces.length || this.late.length) {
      const before = this.queued;
      await this.flush();
      if (this.queued >= before) break; // failed; leave the rest for the next run
    }
  }

  /** Write one batch of up to `batchSpans` spans. */
  async flush(): Promise<void> {
    if (!this.traces.length && !this.late.length) return;
    let n = 0;
    let ti = 0;
    while (ti < this.traces.length && (n === 0 || n + this.traces[ti].spans.length <= this.batchSpans)) {
      n += this.traces[ti].spans.length;
      ti++;
    }
    const traces = this.traces.slice(0, ti);
    const late = this.late.slice(0, Math.max(0, this.batchSpans - n));
    const started = performance.now();
    try {
      await this.write(traces, late);
    } catch (err) {
      if (++this.attempts < MAX_ATTEMPTS) throw err;
      this.s.abandonedBatches++;
      this.s.abandonedSpans += n + late.length;
      console.error('kept-trace batch abandoned after repeated failures:', (err as Error).message);
    }
    this.attempts = 0;
    this.traces.splice(0, ti);
    this.late.splice(0, late.length);
    this.queued -= n + late.length;
    this.s.lastWriteMs = performance.now() - started;
  }

  private async write(traces: KeptTrace[], late: KeptSpanRow[]): Promise<void> {
    const sp = {
      time: [] as string[],
      trace: [] as (string | null)[],
      span: [] as string[],
      parent: [] as (string | null)[],
      svc: [] as string[],
      peer: [] as (string | null)[],
      name: [] as string[],
      kind: [] as number[],
      dur: [] as number[],
      isErr: [] as boolean[],
      isRoot: [] as boolean[],
      http: [] as (number | null)[],
      attrs: [] as string[],
    };
    const push = (s: KeptSpanRow) => {
      if (!hexToUuid(s.traceId)) return;
      sp.time.push(new Date(s.startMs).toISOString());
      sp.trace.push(hexToUuid(s.traceId));
      sp.span.push(spanWordsToBigint(s.spanHi, s.spanLo));
      sp.parent.push(s.parentHi == null || s.parentLo == null ? null : spanWordsToBigint(s.parentHi, s.parentLo));
      sp.svc.push(s.serviceId);
      sp.peer.push(s.peerServiceId);
      sp.name.push(s.name);
      sp.kind.push(s.kind);
      sp.dur.push(s.durationMs);
      sp.isErr.push(s.isError);
      sp.isRoot.push(s.isRoot);
      sp.http.push(s.httpStatus);
      sp.attrs.push(cleanJson(s.attrsJson));
    };
    const tr = {
      time: [] as string[], trace: [] as (string | null)[], rootSvc: [] as (string | null)[], rootOp: [] as (string | null)[],
      dur: [] as number[], count: [] as number[], hasErr: [] as boolean[], reason: [] as string[],
    };
    const ts = { time: [] as string[], svc: [] as string[], trace: [] as (string | null)[], hasErr: [] as boolean[], ops: [] as string[] };
    for (const t of traces) {
      const time = new Date(t.startMs).toISOString();
      const uuid = hexToUuid(t.traceId);
      // Not a 16-byte trace id: nothing could look it up again, so skip it.
      if (!uuid) continue;
      for (const s of t.spans) push(s);
      tr.time.push(time);
      tr.trace.push(uuid);
      tr.rootSvc.push(t.rootService);
      tr.rootOp.push(t.rootOperation);
      tr.dur.push(t.durationMs);
      tr.count.push(t.spans.length);
      tr.hasErr.push(t.hasError);
      tr.reason.push(t.reason);
      for (const [svc, info] of t.services) {
        ts.time.push(time);
        ts.svc.push(svc);
        ts.trace.push(uuid);
        ts.hasErr.push(info.hasError);
        ts.ops.push([...info.errorOps].join('\u001f'));
      }
    }
    for (const s of late) push(s);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (sp.time.length) {
        await client.query(
          `INSERT INTO kept_spans (time, trace_id, span_id, parent_span_id, service_id, peer_service_id,
                                   name, kind, duration_ms, is_error, is_root, http_status, attrs)
           SELECT * FROM unnest($1::timestamptz[], $2::uuid[], $3::bigint[], $4::bigint[], $5::text[], $6::text[],
                                $7::text[], $8::smallint[], $9::float8[], $10::bool[], $11::bool[], $12::int[], $13::jsonb[])`,
          [sp.time, sp.trace, sp.span, sp.parent, sp.svc, sp.peer, sp.name, sp.kind, sp.dur, sp.isErr, sp.isRoot, sp.http, sp.attrs],
        );
      }
      if (tr.time.length) {
        await client.query(
          `INSERT INTO kept_traces (time, trace_id, root_service, root_operation, duration_ms, span_count, has_error, reason)
           SELECT * FROM unnest($1::timestamptz[], $2::uuid[], $3::text[], $4::text[], $5::float8[], $6::int[], $7::bool[], $8::text[])`,
          [tr.time, tr.trace, tr.rootSvc, tr.rootOp, tr.dur, tr.count, tr.hasErr, tr.reason],
        );
        await client.query(
          `INSERT INTO kept_trace_services (time, service_id, trace_id, has_error, error_ops)
           SELECT u.time, u.svc, u.trace, u.has_err,
                  CASE WHEN u.ops = '' THEN '{}'::text[] ELSE string_to_array(u.ops, E'\\x1f') END
           FROM unnest($1::timestamptz[], $2::text[], $3::uuid[], $4::bool[], $5::text[]) AS u(time, svc, trace, has_err, ops)`,
          [ts.time, ts.svc, ts.trace, ts.hasErr, ts.ops],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    this.s.writtenTraces += traces.length;
    this.s.writtenSpans += sp.time.length;
  }

  stats(): KeptWriterStats {
    return { queuedTraces: this.traces.length, queuedSpans: this.queued, ...this.s };
  }
}
