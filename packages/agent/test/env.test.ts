// Provider selection and spend limits from env: Flovia by default, Anthropic only when asked, no fallback.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ANTHROPIC_DEFAULT_MODEL,
  AnthropicProvider,
  DEFAULT_SPEND_LOG,
  DEFAULT_STOP_FILE,
  FLOVIA_DEFAULT_BASE_URL,
  FLOVIA_DEFAULT_MODEL,
  FloviaProvider,
  assertAgentEnabled,
  providerFromEnv,
  spendGuardFromEnv,
} from '../src/index.js';
import { ScriptedProvider, cannedFetch, fixture, json } from './helpers.js';

const FLOVIA = { FLOVIA_API_KEY: 'test-flovia-key', FLOVIA_BASE_URL: 'https://llm.example.test/v1' };
const ANTHROPIC = { ANTHROPIC_API_KEY: 'test-anthropic-key' };

describe('assertAgentEnabled', () => {
  it('is off unless ENABLE_LLM_AGENT is exactly yes', () => {
    for (const v of [undefined, '', 'YES', 'true', '1']) {
      expect(() => {
        assertAgentEnabled({ ENABLE_LLM_AGENT: v });
      }).toThrow('LLM_AGENT_DISABLED');
    }
    expect(() => {
      assertAgentEnabled({ ENABLE_LLM_AGENT: 'yes' });
    }).not.toThrow();
  });
});

describe('providerFromEnv', () => {
  it('defaults to Flovia (unset or empty LLM_PROVIDER) with the default model', () => {
    for (const env of [FLOVIA, { ...FLOVIA, LLM_PROVIDER: '' }, { ...FLOVIA, LLM_PROVIDER: 'flovia' }]) {
      const p = providerFromEnv(env);
      expect(p).toBeInstanceOf(FloviaProvider);
      expect(p.model).toBe(FLOVIA_DEFAULT_MODEL);
    }
    expect(providerFromEnv({ ...FLOVIA, FLOVIA_MODEL: 'other' }).model).toBe('other');
  });

  it('uses Anthropic only when LLM_PROVIDER=anthropic', () => {
    const p = providerFromEnv({ ...FLOVIA, ...ANTHROPIC, LLM_PROVIDER: 'anthropic' });
    expect(p).toBeInstanceOf(AnthropicProvider);
    expect(p.model).toBe(ANTHROPIC_DEFAULT_MODEL);
    expect(providerFromEnv({ ...ANTHROPIC, LLM_PROVIDER: 'anthropic', ANTHROPIC_MODEL: 'x' }).model).toBe(
      'x',
    );
    // Anthropic key present but not selected → still Flovia.
    expect(providerFromEnv({ ...FLOVIA, ...ANTHROPIC })).toBeInstanceOf(FloviaProvider);
  });

  it('no fallback: missing Flovia vars fail even when an Anthropic key is set, and the other way round', () => {
    expect(() => providerFromEnv({ ...ANTHROPIC })).toThrow('LLM_CONFIG_MISSING:FLOVIA_API_KEY');
    expect(() => providerFromEnv({ ...FLOVIA, LLM_PROVIDER: 'anthropic' })).toThrow(
      'LLM_CONFIG_MISSING:ANTHROPIC_API_KEY',
    );
    expect(() => providerFromEnv({ ...FLOVIA, ...ANTHROPIC, LLM_PROVIDER: 'openai' })).toThrow(
      'LLM_PROVIDER_UNKNOWN',
    );
  });

  it('passes the fetch hook and the run id through', async () => {
    const { fetch, sent } = cannedFetch([json(fixture('flovia-responses-completed.json'))]);
    await providerFromEnv(FLOVIA, fetch, 'run-fixed').complete({ system: 's', user: 'u', maxTokens: 8 });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('https://llm.example.test/v1/responses');
    expect(sent[0]?.headers['Flovia-Operation-Id']).toBe('claw-pay:run-fixed:1');
  });

  it('uses the Flovia base URL default when FLOVIA_BASE_URL is unset', async () => {
    const { fetch, sent } = cannedFetch([json(fixture('flovia-responses-completed.json'))]);
    const p = providerFromEnv({ FLOVIA_API_KEY: 'k' }, fetch);
    await p.complete({ system: 's', user: 'u', maxTokens: 8 });
    expect(sent[0]?.url).toBe(`${FLOVIA_DEFAULT_BASE_URL}/responses`);
    expect(FLOVIA_DEFAULT_BASE_URL).toBe('https://api.flovia.dev/openai/v1');
    expect(FLOVIA_DEFAULT_MODEL).toBe('gpt-6-luna');
  });

  it('never reads PayPal variables', () => {
    const read: string[] = [];
    const env = new Proxy<Record<string, string | undefined>>(
      { ...FLOVIA },
      {
        get: (t, k: string) => {
          read.push(k);
          return t[k];
        },
      },
    );
    providerFromEnv(env);
    spendGuardFromEnv(env, { fileExists: () => false, appendLine: () => undefined });
    expect(read.filter((k) => k.startsWith('PAYPAL'))).toEqual([]);
  });
});

describe('spendGuardFromEnv', () => {
  const p = () => new ScriptedProvider('{}');

  it('defaults: 512 tokens, 0.05 USD per run, 3 calls, default stop file and log path', async () => {
    const checked: string[] = [];
    const appended: [string, string][] = [];
    const g = spendGuardFromEnv(
      {},
      {
        fileExists: (f) => (checked.push(f), false),
        appendLine: (f, l) => appended.push([f, l]),
        clock: () => 0,
      },
    );
    const prov = p();
    for (let i = 0; i < 3; i++) await g.complete(prov, 's', 'u');
    await expect(g.complete(prov, 's', 'u')).rejects.toThrow('LLM_CALL_CAP');
    expect(prov.seen[0]?.maxTokens).toBe(512);
    expect(checked[0]).toBe(DEFAULT_STOP_FILE);
    expect(appended[0]?.[0]).toBe(DEFAULT_SPEND_LOG);
    expect(JSON.parse(appended[0]?.[1] ?? '{}')).toMatchObject({ provider: 'mock', costNanoUsd: '150000' });
  });

  it('LLM_HARD_STOP=yes or the stop file stops before any provider call', async () => {
    const deps = { fileExists: () => false, appendLine: () => undefined };
    const a = p();
    await expect(spendGuardFromEnv({ LLM_HARD_STOP: 'yes' }, deps).complete(a, 's', 'u')).rejects.toThrow(
      'LLM_HARD_STOP',
    );
    const b = p();
    const g = spendGuardFromEnv(
      { LLM_STOP_FILE: '/tmp/x-stop' },
      { fileExists: (f) => f === '/tmp/x-stop', appendLine: () => undefined },
    );
    await expect(g.complete(b, 's', 'u')).rejects.toThrow('LLM_HARD_STOP');
    expect(a.seen.length + b.seen.length).toBe(0);
  });

  it('reads LLM_MAX_TOKENS, LLM_MAX_CALLS and LLM_MAX_RUN_USD', async () => {
    const g = spendGuardFromEnv(
      { LLM_MAX_TOKENS: '64', LLM_MAX_CALLS: '1', LLM_MAX_RUN_USD: '0.000001' },
      { fileExists: () => false, appendLine: () => undefined },
    );
    // Worst case at 100/500 nano-USD per token with 64 output tokens is above 1000 nano-USD.
    await expect(g.complete(p(), 's', 'u')).rejects.toThrow('LLM_RUN_CAP');
  });

  it.each([
    ['LLM_MAX_TOKENS', 'abc', 'LLM_CONFIG_BAD:LLM_MAX_TOKENS'],
    ['LLM_MAX_TOKENS', '4096', 'LLM_CONFIG'],
    ['LLM_MAX_CALLS', '0', 'LLM_CONFIG_BAD:LLM_MAX_CALLS'],
    ['LLM_MAX_RUN_USD', '5.0000000001', 'LLM_CONFIG_BAD:LLM_MAX_RUN_USD'],
  ])('%s=%s → %s', (name, value, err) => {
    expect(() => spendGuardFromEnv({ [name]: value })).toThrow(err);
  });

  it('the default log writer creates the folder and appends one JSON line per call (0600)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-spend-'));
    const log = join(dir, 'nested', 'spend.jsonl');
    const g = spendGuardFromEnv({ LLM_SPEND_LOG: log, LLM_STOP_FILE: join(dir, 'STOP') });
    await g.complete(p(), 's', 'u');
    await g.complete(p(), 's', 'u');
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1] ?? '{}')).toMatchObject({ runTotalNanoUsd: '300000' });
  });
});
