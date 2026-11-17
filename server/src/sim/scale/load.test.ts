import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentFor, post, tracesEndpoint } from './load.js';

describe('tracesEndpoint', () => {
  it('appends /v1/traces to the base URL, keeping any path prefix', () => {
    expect(tracesEndpoint('http://127.0.0.1:4318').href).toBe('http://127.0.0.1:4318/v1/traces');
    expect(tracesEndpoint('http://127.0.0.1:4318/').href).toBe('http://127.0.0.1:4318/v1/traces');
    expect(tracesEndpoint('https://otel.example.com/tracemap/otlp/').href).toBe('https://otel.example.com/tracemap/otlp/v1/traces');
    expect(tracesEndpoint('https://otel.example.com/otlp?tenant=a').href).toBe('https://otel.example.com/otlp/v1/traces?tenant=a');
  });

  it('uses a URL that already names the traces endpoint as is', () => {
    expect(tracesEndpoint('https://otel.example.com/x/v1/traces').href).toBe('https://otel.example.com/x/v1/traces');
  });

  it('defaults the port from the scheme', () => {
    const u = tracesEndpoint('https://otel.example.com');
    expect(u.protocol).toBe('https:');
    expect(u.port).toBe('');
  });

  it('rejects other schemes and junk', () => {
    expect(() => tracesEndpoint('grpc://127.0.0.1:4317')).toThrow(/http:\/\/ or https:\/\//);
    expect(() => tracesEndpoint('127.0.0.1:4318')).toThrow();
    expect(() => tracesEndpoint('not a url')).toThrow(/not a URL/);
  });

  it('picks an https agent for https', () => {
    expect(agentFor(tracesEndpoint('https://x'), 2)).toBeInstanceOf(https.Agent);
    const a = agentFor(tracesEndpoint('http://x'), 2);
    expect(a).toBeInstanceOf(http.Agent);
    expect(a).not.toBeInstanceOf(https.Agent);
  });
});

describe('post', () => {
  let server: http.Server;
  let base: string;
  const paths: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      paths.push(req.url ?? '');
      req.resume();
      req.on('end', () => {
        if (req.url?.startsWith('/ok/')) {
          res.end('{}');
        } else if (req.url?.startsWith('/busy/')) {
          res.writeHead(429, { 'retry-after': '2' }).end();
        } else if (req.url?.startsWith('/hangup/')) {
          // Headers and part of the body, then the connection drops.
          res.writeHead(200, { 'content-length': '1000' });
          res.write('partial');
          setTimeout(() => res.socket?.destroy(), 20);
        } else if (req.url?.startsWith('/reset/')) {
          req.socket.destroy();
        }
        // '/silent/': never answer.
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  const send = (prefix: string, deadlineMs = 5000) => {
    const url = tracesEndpoint(`${base}/${prefix}`);
    const agent = agentFor(url, 1);
    return post(agent, url, Buffer.from('x'), false, deadlineMs).finally(() => agent.destroy());
  };

  it('sends to the prefixed path and reports the status', async () => {
    await expect(send('ok')).resolves.toMatchObject({ status: 200 });
    expect(paths).toContain('/ok/v1/traces');
  });

  it('passes Retry-After through', async () => {
    await expect(send('busy')).resolves.toMatchObject({ status: 429, retryAfter: '2' });
  });

  it('settles as failed when the collector hangs up mid-body', async () => {
    const res = await send('hangup');
    expect(res.status).toBeNull();
    expect(res.ms).toBeLessThan(2000);
  });

  it('settles as failed when the connection resets before the headers', async () => {
    await expect(send('reset')).resolves.toMatchObject({ status: null });
  });

  it('gives up at the deadline when nothing comes back', async () => {
    const res = await send('silent', 150);
    expect(res.status).toBeNull();
    expect(res.ms).toBeGreaterThanOrEqual(140);
    expect(res.ms).toBeLessThan(2000);
  });
});
