import { describe, expect, it } from 'vitest';
import { hostLabel, inferOwnType, inferPeer, runtimeOf, teamOf } from './infer.js';

const noInternal = () => false;

describe('inferPeer', () => {
  it('prefers explicit peer.service', () => {
    const p = inferPeer({ 'peer.service': 'billing' }, (id) => id === 'billing');
    expect(p).toEqual({ id: 'billing', type: 'service', isExternal: false });
  });

  it('maps db.system to typed infra peers using the host label', () => {
    const p = inferPeer(
      { 'db.system': 'postgresql', 'server.address': 'pg-orders.internal', 'server.port': 5432 },
      noInternal,
    );
    expect(p).toEqual({ id: 'pg-orders', type: 'postgres', isExternal: true });
  });

  it('handles legacy net.peer.name and redis', () => {
    const p = inferPeer({ 'db.system': 'redis', 'net.peer.name': 'redis-cart.internal:6379' }, noInternal);
    expect(p).toEqual({ id: 'redis-cart', type: 'redis', isExternal: true });
  });

  it('maps messaging systems', () => {
    const p = inferPeer(
      { 'messaging.system': 'kafka', 'server.address': 'kafka-events.internal' },
      noInternal,
    );
    expect(p).toEqual({ id: 'kafka-events', type: 'kafka', isExternal: true });
  });

  it('maps aws s3 rpc calls', () => {
    const p = inferPeer({ 'rpc.system': 'aws-api', 'rpc.service': 'S3' }, noInternal);
    expect(p).toEqual({ id: 'aws-s3', type: 's3', isExternal: true });
  });

  it('resolves http hosts to internal services when known', () => {
    const p = inferPeer(
      { 'http.request.method': 'GET', 'url.full': 'http://catalog-svc.internal:8080/v1/products' },
      (id) => id === 'catalog-svc',
    );
    expect(p).toEqual({ id: 'catalog-svc', type: 'service', isExternal: false });
  });

  it('treats unknown http hosts as external APIs', () => {
    const p = inferPeer({ 'url.full': 'https://api.stripe.com/v1/payment_intents' }, noInternal);
    expect(p).toEqual({ id: 'api.stripe.com', type: 'external', isExternal: true });
  });

  it('returns null when nothing is inferrable', () => {
    expect(inferPeer({}, noInternal)).toBeNull();
  });
});

describe('helpers', () => {
  it('hostLabel strips ports and domains', () => {
    expect(hostLabel('orders-svc.prod.svc.cluster.local:8080')).toBe('orders-svc');
    expect(hostLabel('api.stripe.com')).toBe('api');
  });

  it('inferOwnType detects gateways and bffs by name', () => {
    expect(inferOwnType('api-gateway')).toBe('gateway');
    expect(inferOwnType('storefront-bff')).toBe('bff');
    expect(inferOwnType('orders-svc')).toBe('service');
  });

  it('teamOf reads the team.name resource attribute', () => {
    expect(teamOf({ 'team.name': 'Checkout' })).toBe('Checkout');
    expect(teamOf({ 'team.name': '  Checkout  ' })).toBe('Checkout');
    expect(teamOf({ 'team.name': '   ' })).toBeNull();
    expect(teamOf({})).toBeNull();
  });

  it('runtimeOf builds a readable runtime string', () => {
    expect(
      runtimeOf({ 'telemetry.sdk.language': 'go', 'telemetry.sdk.name': 'opentelemetry', 'telemetry.sdk.version': '1.30.0' }),
    ).toBe('opentelemetry-go 1.30.0');
    expect(runtimeOf({})).toBeNull();
  });
});
