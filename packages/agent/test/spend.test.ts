// Spend guard: max_tokens cap, per-run cap (worst case, before the call), call cap, hard stop, spend log.
import { describe, expect, it } from 'vitest';

import {
  FloviaProvider,
  MAX_TOKENS_HARD_CAP,
  SpendGuard,
  costNanoUsd,
  estimateInputTokens,
  usdToNano,
  type SpendLogLine,
} from '../src/index.js';
import { ScriptedProvider, cannedFetch, fixture, json } from './helpers.js';

const limits = { maxTokens: 512, maxRunNanoUsd: 50_000_000n, maxCalls: 3 };
function guard(over: Partial<typeof limits> = {}, stop = () => false) {
  const lines: SpendLogLine[] = [];
  const g = new SpendGuard({
    limits: { ...limits, ...over },
    stopped: stop,
    log: (l) => lines.push(l),
    clock: () => Date.UTC(2026, 10, 1, 9),
  });
  return { g, lines };
}

describe('SpendGuard', () => {
  it('passes maxTokens to the provider and logs counts and cost only', async () => {
    const { g, lines } = guard();
    const p = new ScriptedProvider('secret prompt reply');
    await g.complete(p, 'SYSTEM-TEXT', 'USER-TEXT');
    expect(p.seen[0]?.maxTokens).toBe(512);
    expect(g.spentNanoUsd).toBe(1000n * 100n + 100n * 500n);
    expect(g.calls).toBe(1);
    expect(lines).toEqual([
      {
        at: '2026-11-01T09:00:00.000Z',
        provider: 'mock',
        model: 'scripted',
        inputTokens: 1000,
        outputTokens: 100,
        costNanoUsd: '150000',
        runTotalNanoUsd: '150000',
        status: 'completed',
      },
    ]);
    const logged = JSON.stringify(lines);
    for (const s of ['SYSTEM-TEXT', 'USER-TEXT', 'secret prompt reply']) expect(logged).not.toContain(s);
  });

  it('Flovia: logs usage at cost 0 with the operation id (recorded reply)', async () => {
    const { g, lines } = guard();
    const { fetch } = cannedFetch([json(fixture('flovia-responses-completed.json'))]);
    const p = new FloviaProvider({
      apiKey: 'k',
      baseUrl: 'https://x.test/v1',
      model: 'gpt-6-luna',
      runId: 'r-0001',
      fetch,
    });
    expect((await g.complete(p, 's', 'u')).text).toBe('{"intents":[]}');
    expect(lines).toEqual([
      {
        at: '2026-11-01T09:00:00.000Z',
        provider: 'flovia',
        model: 'gpt-6-luna',
        inputTokens: 20,
        outputTokens: 12,
        costNanoUsd: '0',
        runTotalNanoUsd: '0',
        status: 'completed',
        operationId: 'claw-pay:r-0001:1',
      },
    ]);
  });

  it('a cut-off reply is logged and counted, then refused (recorded reply)', async () => {
    const { g, lines } = guard();
    const { fetch } = cannedFetch([json(fixture('flovia-responses-incomplete.json'))]);
    const p = new FloviaProvider({
      apiKey: 'k',
      baseUrl: 'https://x.test/v1',
      model: 'gpt-6-luna',
      runId: 'r-0001',
      fetch,
    });
    await expect(g.complete(p, 's', 'u')).rejects.toThrow('LLM_REPLY_INCOMPLETE:max_output_tokens');
    expect(g.calls).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ inputTokens: 19, outputTokens: 20, status: 'incomplete' });
  });

  it('hard stop: refuses before the call, so the provider is never reached', async () => {
    let stop = false;
    const { g } = guard({}, () => stop);
    const p = new ScriptedProvider('{}');
    await g.complete(p, 's', 'u');
    stop = true;
    await expect(g.complete(p, 's', 'u')).rejects.toThrow('LLM_HARD_STOP');
    expect(p.seen).toHaveLength(1);
  });

  it('call cap', async () => {
    const { g } = guard({ maxCalls: 1 });
    const p = new ScriptedProvider('{}');
    await g.complete(p, 's', 'u');
    await expect(g.complete(p, 's', 'u')).rejects.toThrow('LLM_CALL_CAP');
    expect(p.seen).toHaveLength(1);
  });

  it('run cap: the worst case (estimated input + full maxTokens) must fit before the call is sent', async () => {
    const p = new ScriptedProvider('{}');
    const worst = costNanoUsd(p.price, estimateInputTokens('su'), 512);
    const ok = guard({ maxRunNanoUsd: worst });
    await ok.g.complete(p, 's', 'u');
    const tight = guard({ maxRunNanoUsd: worst - 1n });
    await expect(tight.g.complete(p, 's', 'u')).rejects.toThrow('LLM_RUN_CAP');
    expect(p.seen).toHaveLength(1);
  });

  it.each([
    ['maxTokens above the hard cap', { maxTokens: MAX_TOKENS_HARD_CAP + 1 }],
    ['maxTokens 0', { maxTokens: 0 }],
    ['fractional maxTokens', { maxTokens: 1.5 }],
    ['negative run cap', { maxRunNanoUsd: -1n }],
    ['maxCalls 0', { maxCalls: 0 }],
  ])('refuses %s', (_n, over) => {
    expect(() => guard(over)).toThrow('LLM_CONFIG');
  });

  it('a provider error still counts the call (no silent retry)', async () => {
    const { g, lines } = guard({ maxCalls: 1 });
    await expect(g.complete(new ScriptedProvider(new Error('boom')), 's', 'u')).rejects.toThrow('boom');
    expect(g.calls).toBe(1);
    expect(lines).toHaveLength(0);
  });

  it('uses the real clock when none is given', async () => {
    const lines: SpendLogLine[] = [];
    const g = new SpendGuard({ limits, stopped: () => false, log: (l) => lines.push(l) });
    await g.complete(new ScriptedProvider('{}'), 's', 'u');
    expect(Date.parse(lines[0]?.at ?? '')).toBeGreaterThan(0);
  });
});

describe('usdToNano', () => {
  it.each<[string, bigint | undefined]>([
    ['0.05', 50_000_000n],
    ['1', 1_000_000_000n],
    ['0.000000001', 1n],
    ['70', 70_000_000_000n],
    ['0.0000000001', undefined],
    ['-1', undefined],
    ['1e3', undefined],
    ['01', undefined],
    ['', undefined],
  ])('%s → %s', (text, want) => {
    expect(usdToNano(text)).toBe(want);
  });
});
