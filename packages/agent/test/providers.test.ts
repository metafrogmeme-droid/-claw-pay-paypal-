// Flovia (Responses API) and Anthropic adapters against recorded, scrubbed replies. No network.
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';

import {
  ANTHROPIC_DEFAULT_MODEL,
  ANTHROPIC_DEFAULT_PRICE,
  ANTHROPIC_URL,
  AnthropicProvider,
  FloviaProvider,
  LlmError,
} from '../src/index.js';
import { cannedFetch, fixture, json } from './helpers.js';

const KEY = 'test-llm-key-not-real';
const REQ = { system: 'sys', user: 'hello', maxTokens: 256 };

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(LlmError);
    expect((e as Error).message).not.toContain(KEY);
    return (e as LlmError).code;
  }
  throw new Error('expected a rejection');
};

describe('FloviaProvider (Responses API)', () => {
  const make = (replies: (Response | Error)[], baseUrl = 'https://llm.example.test/openai/v1/') => {
    const f = cannedFetch(replies);
    return {
      ...f,
      p: new FloviaProvider({ apiKey: KEY, baseUrl, model: 'gpt-6-luna', runId: 'run-0001', fetch: f.fetch }),
    };
  };

  it('posts a Responses request with an operation id and reads output_text and usage (recorded reply)', async () => {
    const { p, sent } = make([json(fixture('flovia-responses-completed.json'))]);
    expect(await p.complete(REQ)).toEqual({
      text: '{"intents":[]}',
      inputTokens: 20,
      outputTokens: 12,
      operationId: 'claw-pay:run-0001:1',
    });
    expect(sent).toHaveLength(1);
    const [s] = sent;
    expect(s?.url).toBe('https://llm.example.test/openai/v1/responses');
    expect(s?.init.method).toBe('POST');
    expect(s?.init.redirect).toBe('error');
    expect(s?.headers['Authorization']).toBe(`Bearer ${KEY}`);
    expect(s?.headers['Content-Type']).toBe('application/json');
    expect(s?.headers['Flovia-Operation-Id']).toBe('claw-pay:run-0001:1');
    expect(s?.body).toEqual({
      model: 'gpt-6-luna',
      input: 'sys\n\nhello',
      max_output_tokens: 256,
      reasoning: { effort: 'none' },
      text: { format: { type: 'json_object' } },
    });
    expect(p.price).toEqual({ inputNanoUsd: 0n, outputNanoUsd: 0n });
  });

  it('uses a new operation id for every call (each call is a new generation; no retries)', async () => {
    const r = fixture('flovia-responses-completed.json');
    const { p, sent } = make([json(r), json(r)]);
    await p.complete(REQ);
    await p.complete(REQ);
    expect(sent.map((s) => s.headers['Flovia-Operation-Id'])).toEqual([
      'claw-pay:run-0001:1',
      'claw-pay:run-0001:2',
    ]);
  });

  it('makes a random run id in the allowed format when none is given', async () => {
    const r = fixture('flovia-responses-completed.json');
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const f = cannedFetch([json(r)]);
      const p = new FloviaProvider({ apiKey: KEY, baseUrl: 'https://x.test/v1', model: 'm', fetch: f.fetch });
      await p.complete(REQ);
      ids.push(f.sent[0]?.headers['Flovia-Operation-Id'] ?? '');
    }
    for (const id of ids) expect(id).toMatch(/^claw-pay:[A-Za-z0-9_.:-]+:1$/);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('refuses a run id that would break the operation id format, before any call', () => {
    for (const runId of ['', 'has space', 'x'.repeat(120), 'slash/no']) {
      expect(() => new FloviaProvider({ apiKey: KEY, baseUrl: 'https://x.test', model: 'm', runId })).toThrow(
        'LLM_CONFIG_BAD:runId',
      );
    }
  });

  it('returns a cut-off reply marked incomplete with its reason and usage (recorded reply)', async () => {
    const { p } = make([json(fixture('flovia-responses-incomplete.json'))]);
    expect(await p.complete(REQ)).toEqual({
      text: '1, 2, 3, 4, 5, 6,',
      inputTokens: 19,
      outputTokens: 20,
      operationId: 'claw-pay:run-0001:1',
      incomplete: 'max_output_tokens',
    });
  });

  it('marks an incomplete reply without a readable reason as unknown', async () => {
    const usage = { input_tokens: 3, output_tokens: 4 };
    for (const details of [null, {}, { reason: 'Not A Code' }]) {
      const { p } = make([json({ status: 'incomplete', incomplete_details: details, output: [], usage })]);
      const r = await p.complete(REQ);
      expect(r.incomplete).toBe('unknown');
      expect(r.text).toBe('');
    }
  });

  it('joins only output_text parts of message items', async () => {
    const { p } = make([
      json({
        status: 'completed',
        output: [
          { type: 'reasoning' },
          { type: 'message', content: [{ type: 'output_text', text: 'a' }, { type: 'refusal' }] },
          { type: 'message' },
          { type: 'message', content: [{ type: 'output_text' }, { type: 'output_text', text: 'b' }] },
        ],
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
    ]);
    expect((await p.complete(REQ)).text).toBe('ab');
  });

  it.each<[string, Record<string, unknown>, string]>([
    [
      'failed with a code',
      { status: 'failed', error: { code: 'server_error' } },
      'LLM_STATUS_FAILED:server_error',
    ],
    ['failed without a code', { status: 'failed', error: null }, 'LLM_STATUS_FAILED'],
    ['failed with an odd code', { status: 'failed', error: { code: 'Bad Code!' } }, 'LLM_STATUS_FAILED'],
    ['cancelled', { status: 'cancelled' }, 'LLM_STATUS_CANCELLED'],
    ['in progress', { status: 'in_progress' }, 'LLM_STATUS_IN_PROGRESS'],
    ['an odd status', { status: 'Weird Status' }, 'LLM_STATUS_UNKNOWN'],
  ])('maps a reply that is %s to a code', async (_n, extra, want) => {
    const { p } = make([json({ output: [], usage: { input_tokens: 1, output_tokens: 0 }, ...extra })]);
    expect(await code(p.complete(REQ))).toBe(want);
  });

  it('refuses a non-https base URL and an empty key before any call', () => {
    expect(() => new FloviaProvider({ apiKey: KEY, baseUrl: 'http://llm.example.test', model: 'm' })).toThrow(
      'LLM_URL_NOT_HTTPS',
    );
    expect(() => new FloviaProvider({ apiKey: '', baseUrl: 'https://llm.example.test', model: 'm' })).toThrow(
      'LLM_CONFIG',
    );
  });

  it.each<[string, Response | Error, string]>([
    [
      'a missing operation id (recorded 400)',
      json(fixture('flovia-error-operation-id.json'), 400),
      'LLM_HTTP_400:invalid_operation_id',
    ],
    [
      'a blocked request (recorded 403)',
      json(fixture('flovia-error-blocked.json'), 403),
      'LLM_HTTP_403:request_blocked',
    ],
    [
      'an HTTP error with a non-JSON body (no body echo)',
      new Response(`bad key ${KEY}`, { status: 401 }),
      'LLM_HTTP_401',
    ],
    [
      'an error body whose code is not a plain code',
      json({ error: { code: `x ${KEY}` } }, 500),
      'LLM_HTTP_500',
    ],
    [
      'an error body with only a type',
      json({ error: { type: 'rate_limit_error' } }, 429),
      'LLM_HTTP_429:rate_limit_error',
    ],
    ['an error body without error', json({}, 502), 'LLM_HTTP_502'],
    ['a network failure', new Error(`ECONNRESET ${KEY}`), 'LLM_NETWORK_FAILED'],
    ['a non-JSON body', new Response('<html>', { status: 200 }), 'LLM_REPLY_UNREADABLE'],
    ['a wrong shape', json({ choices: [] }), 'LLM_REPLY_UNREADABLE'],
  ])('maps %s to a code without the key or the message', async (_n, reply, want) => {
    const { p } = make([reply]);
    const got = await code(p.complete(REQ));
    expect(got).toBe(want);
    expect(got).not.toContain('Send the');
  });

  it('never shows the key in JSON or inspect', () => {
    const { p } = make([]);
    for (const s of [JSON.stringify(p), inspect(p, { showHidden: true, depth: 5 })]) {
      expect(s).not.toContain(KEY);
    }
    expect(JSON.parse(JSON.stringify(p))).toEqual({ name: 'flovia', model: 'gpt-6-luna' });
  });

  it('uses globalThis.fetch when none is given (blocked in tests by the network-deny setup)', async () => {
    const p = new FloviaProvider({ apiKey: KEY, baseUrl: 'https://llm.example.test', model: 'm' });
    expect(await code(p.complete(REQ))).toBe('LLM_NETWORK_FAILED');
  });
});

describe('AnthropicProvider', () => {
  it('posts to the fixed Messages URL with the cheap default model and joins text blocks only', async () => {
    const { fetch, sent } = cannedFetch([json(fixture('anthropic-messages.json'))]);
    const p = new AnthropicProvider({ apiKey: KEY, fetch });
    expect(p.model).toBe(ANTHROPIC_DEFAULT_MODEL);
    expect(p.price).toEqual(ANTHROPIC_DEFAULT_PRICE);
    expect(await p.complete(REQ)).toEqual({ text: '{"intents":[]}', inputTokens: 400, outputTokens: 10 });
    const [s] = sent;
    expect(s?.url).toBe(ANTHROPIC_URL);
    expect(s?.headers['x-api-key']).toBe(KEY);
    expect(s?.headers['anthropic-version']).toBe('2023-06-01');
    expect(s?.body).toEqual({
      model: ANTHROPIC_DEFAULT_MODEL,
      max_tokens: 256,
      system: 'sys',
      messages: [{ role: 'user', content: 'hello' }],
    });
  });

  it('takes a model and price override; refuses an empty key; hides the key', async () => {
    const { fetch } = cannedFetch([
      json({ content: [{ type: 'text' }], usage: { input_tokens: 1, output_tokens: 0 } }),
    ]);
    const price = { inputNanoUsd: 1n, outputNanoUsd: 2n };
    const p = new AnthropicProvider({ apiKey: KEY, model: 'other', price, fetch });
    expect(p.price).toBe(price);
    expect((await p.complete(REQ)).text).toBe('');
    expect(JSON.stringify(p)).toBe('{"name":"anthropic","model":"other"}');
    expect(() => new AnthropicProvider({ apiKey: '' })).toThrow('LLM_CONFIG');
  });

  it('marks a reply cut off at max_tokens as incomplete (recorded live reply)', async () => {
    const { fetch } = cannedFetch([json(fixture('anthropic-messages-max-tokens.json'))]);
    const p = new AnthropicProvider({ apiKey: KEY, fetch });
    expect(await p.complete(REQ)).toEqual({
      text: '[1, 2, 3',
      inputTokens: 37,
      outputTokens: 8,
      incomplete: 'max_tokens',
    });
  });

  it('a 429 maps to LLM_HTTP_429 and is not retried', async () => {
    const { fetch, sent } = cannedFetch([new Response('{}', { status: 429 })]);
    const p = new AnthropicProvider({ apiKey: KEY, fetch });
    expect(await code(p.complete(REQ))).toBe('LLM_HTTP_429');
    expect(sent).toHaveLength(1);
  });
});
