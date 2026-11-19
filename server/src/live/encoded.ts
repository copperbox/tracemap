import { promisify } from 'node:util';
import zlib from 'node:zlib';
import type { FastifyReply, FastifyRequest } from 'fastify';

const gzip = promisify(zlib.gzip);
const brotli = promisify(zlib.brotliCompress);

export type Encoding = 'br' | 'gzip';

/**
 * A response body shared by every viewer: serialized once, compressed at most
 * once per encoding (on the zlib thread pool), whoever asks first.
 */
export class Encoded {
  private readonly cache = new Map<Encoding, Promise<Buffer>>();

  constructor(
    readonly raw: Buffer,
    readonly contentType: string,
    /** Quoted ETag value, or null. */
    readonly etag: string | null = null,
  ) {}

  static json(value: unknown, etag: string | null = null): Encoded {
    return new Encoded(Buffer.from(JSON.stringify(value)), 'application/json; charset=utf-8', etag);
  }

  get(enc: Encoding): Promise<Buffer> {
    let p = this.cache.get(enc);
    if (!p) {
      p =
        enc === 'br'
          ? brotli(this.raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: this.raw.length } })
          : gzip(this.raw, { level: 6 });
      // A failed compression is retried by the next request rather than cached.
      p.catch(() => this.cache.delete(enc));
      this.cache.set(enc, p);
    }
    return p;
  }
}

/** Preferred encoding the client accepts (br, then gzip), or null for identity. */
export function pickEncoding(accept: string | string[] | undefined): Encoding | null {
  const header = (Array.isArray(accept) ? accept.join(',') : accept ?? '').toLowerCase();
  const accepted = new Set<string>();
  for (const part of header.split(',')) {
    const [name, ...params] = part.trim().split(';');
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    if (q && Number(q.slice(2)) === 0) continue;
    accepted.add(name.trim());
  }
  if (accepted.has('br')) return 'br';
  if (accepted.has('gzip') || accepted.has('*')) return 'gzip';
  return null;
}

/** Below this the raw body is sent: compressing a tiny body costs more than it saves. */
const MIN_COMPRESS_BYTES = 1024;

/** Send a shared body, honoring If-None-Match and Accept-Encoding. */
export async function sendEncoded(req: FastifyRequest, reply: FastifyReply, body: Encoded): Promise<FastifyReply> {
  reply.header('vary', 'accept-encoding');
  reply.header('cache-control', 'no-cache');
  if (body.etag) {
    reply.header('etag', body.etag);
    if (req.headers['if-none-match'] === body.etag) return reply.code(304).send();
  }
  reply.type(body.contentType);
  const enc = body.raw.length >= MIN_COMPRESS_BYTES ? pickEncoding(req.headers['accept-encoding']) : null;
  if (!enc) return reply.send(body.raw);
  const out = await body.get(enc);
  reply.header('content-encoding', enc);
  return reply.send(out);
}

/** Route option that keeps @fastify/compress off a route that compresses itself (or streams). */
export const NO_COMPRESS = { compress: false as const };
