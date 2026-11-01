// `cp-agent` with a canned LLM reply. Mock PayPal by default; --sandbox on recorded sandbox replies.
import { describe, expect, it } from 'vitest';

import { fakeFetch, fixture, TOKEN } from '../../paypal/test/fake-fetch.js';
import { DEFAULT_TASK, runAgentCli } from '../src/agent-run.js';
import { INJECTED_TEXT } from '../src/demo-paypal.js';

const SECRET = 'test-client-secret-not-real';
const LLM_KEY = 'test-flovia-key-not-real';
const ENV = {
  ENABLE_LLM_AGENT: 'yes',
  FLOVIA_API_KEY: LLM_KEY,
  FLOVIA_BASE_URL: 'https://llm.example.test/v1',
};
const PAYPAL = {
  PAYPAL_ENVIRONMENT: 'SANDBOX',
  PAYPAL_SANDBOX_CLIENT_ID: 'test-client-id-not-real',
  PAYPAL_SANDBOX_CLIENT_SECRET: SECRET,
  PAYPAL_SANDBOX_PAYEE_MERCHANT_ID: 'FAKEMERCHANT01',
};
const order = (cost: number, extra: Record<string, unknown> = {}) => ({
  currencyCode: 'USD',
  items: [{ name: 'API credits', quantity: 1, itemCost: cost, taxPercent: 0, itemTotal: cost }],
  ...extra,
});

function llm(content: string) {
  const prompts: string[] = [];
  const opIds: string[] = [];
  const fetch = (_url: string, init: RequestInit) => {
    prompts.push(init.body as string);
    opIds.push((init.headers as Record<string, string>)['Flovia-Operation-Id'] ?? '');
    return Promise.resolve(
      new Response(
        JSON.stringify({
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: content }] }],
          usage: { input_tokens: 300, output_tokens: 40 },
        }),
      ),
    );
  };
  return { fetch, prompts, opIds };
}

async function cli(
  argv: string[],
  env: Record<string, string>,
  content: string,
  paypalReplies = [] as never[],
) {
  const l = llm(content);
  const p = fakeFetch(paypalReplies);
  const lines: string[] = [];
  const code = await runAgentCli(argv, env, (x) => lines.push(x), {
    llmFetch: l.fetch,
    paypalFetch: p.fetch,
    fileExists: () => false,
    appendLine: () => undefined,
    runId: 'test-run-1',
  });
  const text = lines.join('\n');
  for (const v of Object.values(env)) if (v.includes('not-real')) expect(text).not.toContain(v);
  return { code, text, prompts: l.prompts, opIds: l.opIds, paypal: p.calls };
}

const intents = (...i: unknown[]) => JSON.stringify({ intents: i });

describe('runAgentCli', () => {
  it('mock PayPal by default: an allowed order prints the buyer step and the spend', async () => {
    const r = await cli([], ENV, intents({ tool: 'create_order', args: order(2) }));
    expect(r.code).toBe(0);
    expect(r.text).toContain('Claw Pay agent run test-run-1: flovia gpt-6-luna, PayPal mock');
    expect(r.opIds).toEqual(['claw-pay:test-run-1:1']);
    expect(r.text).toContain('  proposed: {"currencyCode":"USD","items":[{"name":"API credits"');
    expect(r.text).toContain('create_order -> Allowed: within your limits [order MOCK');
    expect(r.text).toContain('buyer step: https://www.sandbox.paypal.com/checkoutnow?token=MOCK');
    expect(r.text).not.toContain('sandbox-resume'); // mock orders cannot be resumed
    expect(r.text).toContain('status OK, 1 intents, 1 LLM calls, 0.000000000 USD');
    expect(r.prompts[0]).toContain(JSON.stringify(DEFAULT_TASK).slice(1, -1));
    expect(r.paypal).toHaveLength(0);
  });

  it('--inject: the page text reaches the model; the swapped payee is blocked', async () => {
    const r = await cli(
      ['--inject', 'buy', 'credits'],
      ENV,
      intents({
        tool: 'create_order',
        args: order(2, {
          payee: { merchant_id: 'ATTACKERMERCHANT1', email_address: 'seller-a@business.example.com' },
        }),
      }),
    );
    expect(r.prompts[0]).toContain('ATTACKERMERCHANT1');
    expect(r.prompts[0]).toContain(JSON.stringify(INJECTED_TEXT).slice(1, 40));
    expect(r.text).toContain('Blocked by your rule: PAYTO_MISMATCH');
    expect(r.prompts[0]).toContain('Task: buy credits');
  });

  it('--sandbox uses the sandbox client with your payee', async () => {
    const r = await cli(
      ['--sandbox'],
      { ...ENV, ...PAYPAL },
      intents({ tool: 'create_order', args: order(2) }),
      [TOKEN, { status: 201, body: fixture('create-order.json') }] as never[],
    );
    expect(r.code).toBe(0);
    expect(r.text).toContain('PayPal sandbox');
    expect(r.text).toContain('[order FAKEORDER00000001, PAYER_ACTION_REQUIRED]');
    expect(r.text).toContain(
      '  after the buyer approves: make sandbox-resume ARGS="FAKEORDER00000001 --amount 2.00"',
    );
    expect(r.paypal).toHaveLength(2);
  });

  it('above your confirm threshold: Needs your OK, and the CLI never says yes for you', async () => {
    const r = await cli([], ENV, intents({ tool: 'create_order', args: order(4.5) }));
    expect(r.text).toContain('create_order -> Needs your OK:');
    expect(r.text).not.toContain('buyer step');
  });

  it('an unreadable model reply exits 1 with zero intents', async () => {
    const r = await cli([], ENV, 'sure, paying now');
    expect(r.code).toBe(1);
    expect(r.text).toContain('status REPLY_UNREADABLE, 0 intents');
  });

  it('LLM_HARD_STOP=yes: no LLM call, exit 1', async () => {
    const r = await cli([], { ...ENV, LLM_HARD_STOP: 'yes' }, intents());
    expect(r.code).toBe(1);
    expect(r.text).toContain('status LLM_FAILED (LLM_HARD_STOP)');
    expect(r.prompts).toHaveLength(0);
  });

  it.each<[string, string[], Record<string, string>, string]>([
    ['the agent switched off', [], { ...ENV, ENABLE_LLM_AGENT: '' }, 'LLM_AGENT_DISABLED'],
    ['no Flovia vars', [], { ENABLE_LLM_AGENT: 'yes' }, 'LLM_CONFIG_MISSING:FLOVIA_API_KEY'],
    [
      '--sandbox without a payee',
      ['--sandbox'],
      { ...ENV, ...PAYPAL, PAYPAL_SANDBOX_PAYEE_MERCHANT_ID: '' },
      'PAYPAL_SANDBOX_PAYEE_MERCHANT_ID is not set',
    ],
    [
      '--sandbox on live',
      ['--sandbox'],
      { ...ENV, ...PAYPAL, PAYPAL_ENVIRONMENT: 'LIVE' },
      'Blocked by your rule:',
    ],
  ])('%s → exit 2, nothing sent', async (_n, argv, env, msg) => {
    const r = await cli(argv, env, intents());
    expect(r.code).toBe(2);
    expect(r.text).toContain(msg);
    expect(r.prompts).toHaveLength(0);
    expect(r.paypal).toHaveLength(0);
  });
});
