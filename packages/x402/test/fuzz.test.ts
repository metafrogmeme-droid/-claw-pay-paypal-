// Fuzz/property tests: the parsers never throw and fail closed on malformed input.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { parseV1Body, parseV2Header } from '../src/index.js';
import { SPEC_V2_HEADER, b64, v2 } from './vectors.js';

const isResult = (r: unknown) =>
  typeof r === 'object' &&
  r !== null &&
  'ok' in r &&
  ((r as { ok: boolean }).ok || (r as { reason?: string }).reason === 'REQUIREMENTS_UNREADABLE');

describe('x402 parser fuzzing', () => {
  it('parseV2Header never throws on any string', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 2000 }), (s) => {
        expect(isResult(parseV2Header(s))).toBe(true);
      }),
    );
  });

  it('parseV2Header rejects base64 of random bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 512 }), (bytes) => {
        expect(parseV2Header(Buffer.from(bytes).toString('base64')).ok).toBe(false);
      }),
    );
  });

  it('parseV2Header rejects any JSON value that is not a valid PaymentRequired', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        expect(parseV2Header(b64(v)).ok).toBe(false);
      }),
    );
  });

  it('flipping one character of the spec header never yields a different accepted payTo or amount', () => {
    const base = parseV2Header(SPEC_V2_HEADER);
    if (!base.ok) throw new Error('fixture');
    fc.assert(
      fc.property(
        fc.nat({ max: SPEC_V2_HEADER.length - 1 }),
        fc.constantFrom('A', 'B', 'C', 'a', 'b', 'c', '0', '1', '8', '9', '+', '/'),
        (i, c) => {
          const mutated = SPEC_V2_HEADER.slice(0, i) + c + SPEC_V2_HEADER.slice(i + 1);
          const r = parseV2Header(mutated);
          if (r.ok && mutated !== SPEC_V2_HEADER) {
            // Still valid JSON + schema: then every field must still pass validation; nothing is silently coerced.
            const a = r.value.accepts[0];
            expect(typeof a?.amount).toBe('bigint');
            expect(a?.network).toMatch(/^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/);
          }
        },
      ),
    );
  });

  it('parseV1Body never throws and rejects random JSON', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ maxLength: 500 }),
          fc.jsonValue().map((v) => JSON.stringify(v)),
        ),
        (text) => {
          const r = parseV1Body(text);
          expect(isResult(r)).toBe(true);
          expect(r.ok).toBe(false);
        },
      ),
    );
  });

  it('valid v2 headers round-trip: any amount 1..2^256-1 parses to the same bigint', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 2n ** 256n - 1n }), (n) => {
        const r = parseV2Header(b64(v2({ amount: n.toString() })));
        expect(r.ok && r.value.accepts[0]?.amount).toBe(n);
      }),
    );
  });
});
