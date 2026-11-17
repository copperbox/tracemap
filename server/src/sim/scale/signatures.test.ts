import { describe, expect, it } from 'vitest';
import { errorSignature } from '../../api/errorSignature.js';
import { Prng } from './prng.js';
import { callerSig, peerSigs, serviceSigs, type Sig } from './signatures.js';

const check = (s: Sig) => {
  const attrs: Record<string, unknown> = { ...s.attrs };
  if (s.httpStatus != null) attrs['http.response.status_code'] = s.httpStatus;
  expect(errorSignature(attrs, s.httpStatus)).toEqual({ code: s.code, message: s.message });
};

describe('signatures match the collector grouping', () => {
  it('for service failures in every language', () => {
    const r = new Prng(1);
    for (const lang of ['go', 'java', 'nodejs', 'python', 'rust', 'cpp']) {
      for (let i = 0; i < 10; i++) serviceSigs(lang, () => r.next()).forEach(check);
    }
  });

  it('for what callers see from instrumented callees', () => {
    for (const st of [500, 502, 503, 504]) check(callerSig(st));
  });

  it('for peers', () => {
    for (const t of ['postgres', 'redis', 'kafka', 'elastic', 's3']) peerSigs(t, null).forEach(check);
    for (const h of ['api.stripe.com', 'api.twilio.com', 'api.example.com']) peerSigs('external', h).forEach(check);
  });
});
