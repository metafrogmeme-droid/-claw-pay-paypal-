// Tests for the fail-closed x402 parsers (M2 acceptance).
import { describe, expect, it } from 'vitest';

import {
  MAX_BODY_BYTES,
  MAX_HEADER_BYTES,
  MAX_JSON_DEPTH,
  V1_NETWORKS,
  parseV1Body,
  parseV2Header,
  toPaymentIntent,
} from '../src/index.js';
import { SPEC_V1_BODY, SPEC_V2_HEADER, b64, v2 } from './vectors.js';

const unreadable = { ok: false, reason: 'REQUIREMENTS_UNREADABLE' };

describe('parseV2Header (PAYMENT-REQUIRED)', () => {
  it('parses the spec example exactly', () => {
    const r = parseV2Header(SPEC_V2_HEADER);
    expect(r).toEqual({
      ok: true,
      value: {
        x402Version: 2,
        resourceUrl: 'https://api.example.com/premium-data',
        accepts: [
          {
            scheme: 'exact',
            network: 'eip155:84532',
            amount: 10000n,
            asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
            payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
            maxTimeoutSeconds: 60,
            paymentFlow: 'authorization',
          },
        ],
      },
    });
  });

  it('accepts unpadded base64 and keeps explicit paymentFlow / assetTransferMethod', () => {
    const header = b64(v2({ extra: { paymentFlow: 'upfront', assetTransferMethod: 'permit2' } })).replace(
      /=+$/,
      '',
    );
    const r = parseV2Header(header);
    expect(r.ok && r.value.accepts[0]).toMatchObject({
      paymentFlow: 'upfront',
      assetTransferMethod: 'permit2',
    });
  });

  it('keeps unknown top-level or resource fields out of the result (only modelled fields are read)', () => {
    const r = parseV2Header(b64(v2({}, { extensions: { bazaar: { info: {}, schema: {} } }, future: 1 })));
    expect(r.ok && Object.keys(r.value)).toEqual(['x402Version', 'resourceUrl', 'accepts']);
  });

  it.each<[string, string]>([
    ['empty header', ''],
    ['whitespace inside', ` ${SPEC_V2_HEADER}`],
    ['base64url alphabet', SPEC_V2_HEADER.replace(/\+/g, '-').replace(/\//g, '_') + '-_'],
    ['bad padding', `${SPEC_V2_HEADER}===`],
    ['not base64', '!!!not-base64!!!'],
    ['non-canonical trailing bits', 'eyJhIjoxfR=='],
    ['base64 of non-JSON', Buffer.from('hello').toString('base64')],
    ['base64 of invalid UTF-8', Buffer.from([0xff, 0xfe, 0xfd]).toString('base64')],
    ['JSON array', b64([1, 2])],
    ['JSON null', b64(null)],
    ['x402Version 1 in a v2 header', b64({ ...v2(), x402Version: 1 })],
    ['missing resource', b64({ x402Version: 2, accepts: v2()['accepts'] })],
    ['resource url not a URL', b64(v2({}, { resource: { url: 'not a url' } }))],
    ['resource url not http(s)', b64(v2({}, { resource: { url: 'ftp://api.example.com/x' } }))],
    ['empty accepts', b64(v2({}, { accepts: [] }))],
    ['network not CAIP-2', b64(v2({ network: 'base-sepolia' }))],
    ['amount with decimals', b64(v2({ amount: '0.01' }))],
    ['amount as number', b64(v2({ amount: 10000 }))],
    ['amount with leading zero', b64(v2({ amount: '010000' }))],
    ['negative amount', b64(v2({ amount: '-1' }))],
    ['zero amount', b64(v2({ amount: '0' }))],
    ['empty payTo', b64(v2({ payTo: '' }))],
    ['missing asset', b64(v2({ asset: undefined }))],
    ['maxTimeoutSeconds not an integer', b64(v2({ maxTimeoutSeconds: 1.5 }))],
    ['paymentFlow not a string', b64(v2({ extra: { paymentFlow: 7 } }))],
    ['extra not an object', b64(v2({ extra: 'x' }))],
  ])('%s → REQUIREMENTS_UNREADABLE', (_name, header) => {
    expect(parseV2Header(header)).toMatchObject(unreadable);
  });

  it(`refuses a header over ${String(MAX_HEADER_BYTES)} bytes before decoding`, () => {
    const big = b64(v2({ extra: { pad: 'x'.repeat(MAX_HEADER_BYTES) } }));
    expect(parseV2Header(big)).toMatchObject({ ...unreadable, detail: 'header too large' });
  });

  it(`refuses JSON nested deeper than ${String(MAX_JSON_DEPTH)}`, () => {
    let deep: unknown = 0;
    for (let i = 0; i < MAX_JSON_DEPTH + 1; i++) deep = [deep];
    expect(parseV2Header(b64(v2({ extra: { deep } })))).toMatchObject({
      ...unreadable,
      detail: 'JSON too deep',
    });
  });

  it('refuses an amount above 2^256 - 1', () => {
    expect(parseV2Header(b64(v2({ amount: (2n ** 256n).toString() })))).toMatchObject(unreadable);
  });
});

describe('parseV1Body (402 JSON body)', () => {
  it('parses the spec example and maps base-sepolia to eip155:84532', () => {
    const r = parseV1Body(SPEC_V1_BODY);
    expect(r).toEqual({
      ok: true,
      value: {
        x402Version: 1,
        resourceUrl: 'https://api.example.com/premium-data',
        accepts: [
          {
            scheme: 'exact',
            network: 'eip155:84532',
            amount: 10000n,
            asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
            payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
            maxTimeoutSeconds: 60,
            paymentFlow: 'authorization',
          },
        ],
      },
    });
  });

  it('maps every EVM name in the x402 v1 table, and only those', () => {
    expect(V1_NETWORKS).toMatchObject({
      'base-sepolia': 'eip155:84532',
      base: 'eip155:8453',
      'polygon-amoy': 'eip155:80002',
    });
    expect(Object.keys(V1_NETWORKS)).toHaveLength(15);
  });

  const firstAccept = (text: string): unknown => (JSON.parse(text) as { accepts: unknown[] }).accepts[0];
  const body = (over: Record<string, unknown>) => {
    const b = JSON.parse(SPEC_V1_BODY) as { accepts: Record<string, unknown>[] };
    return JSON.stringify({ ...b, accepts: [{ ...b.accepts[0], ...over }] });
  };

  it.each<[string, string]>([
    ['unknown network name (never guessed)', body({ network: 'base-mainnet' })],
    ['solana name (v1 ids are not CAIP-2)', body({ network: 'solana' })],
    ['a CAIP-2 id in a v1 body', body({ network: 'eip155:84532' })],
    ['amount with decimals', body({ maxAmountRequired: '0.01' })],
    ['missing description', body({ description: undefined })],
    ['resource not a URL', body({ resource: 'nope' })],
    ['x402Version 2 in a v1 body', JSON.stringify({ ...JSON.parse(SPEC_V1_BODY), x402Version: 2 })],
    [
      'accepts entries for different resources',
      JSON.stringify({
        x402Version: 1,
        accepts: [firstAccept(body({})), firstAccept(body({ resource: 'https://other.example.com/x' }))],
      }),
    ],
    ['not JSON', '<html>402</html>'],
  ])('%s → REQUIREMENTS_UNREADABLE', (_n, text) => {
    expect(parseV1Body(text)).toMatchObject(unreadable);
  });

  it(`refuses a body over ${String(MAX_BODY_BYTES)} bytes`, () => {
    expect(parseV1Body(' '.repeat(MAX_BODY_BYTES + 1))).toMatchObject({
      ...unreadable,
      detail: 'body too large',
    });
  });
});

describe('toPaymentIntent without a declared price', () => {
  it('omits declaredAmount', () => {
    const r = parseV2Header(SPEC_V2_HEADER);
    const accept = r.ok ? r.value.accepts[0] : undefined;
    if (!r.ok || !accept) throw new Error('fixture');
    expect(
      toPaymentIntent(r.value, accept, { sellerOrigin: 'https://api.example.com', quoteTime: 5 }),
    ).not.toHaveProperty('declaredAmount');
  });
});

describe('toPaymentIntent', () => {
  it('builds a core intent for one accepts entry', () => {
    const r = parseV2Header(SPEC_V2_HEADER);
    if (!r.ok) throw new Error('fixture');
    const accept = r.value.accepts[0];
    if (!accept) throw new Error('fixture');
    expect(
      toPaymentIntent(r.value, accept, {
        sellerOrigin: 'https://api.example.com',
        quoteTime: 5,
        declaredAmount: 9000n,
      }),
    ).toEqual({
      sellerOrigin: 'https://api.example.com',
      resourceUrl: 'https://api.example.com/premium-data',
      network: 'eip155:84532',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      amount: 10000n,
      payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
      scheme: 'exact',
      quoteTime: 5,
      action: 'pay',
      declaredAmount: 9000n,
    });
  });
});
