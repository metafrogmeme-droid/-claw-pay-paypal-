// Picks the LLM provider and spend limits from env. Flovia unless LLM_PROVIDER=anthropic; no fallback.
// Reads only LLM_* / FLOVIA_* / ANTHROPIC_* names, never the PayPal credentials.
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  ANTHROPIC_DEFAULT_MODEL,
  AnthropicProvider,
  FLOVIA_DEFAULT_BASE_URL,
  FLOVIA_DEFAULT_MODEL,
  FloviaProvider,
  LlmError,
  type FetchLike,
  type LlmProvider,
} from './providers.js';
import { SpendGuard, usdToNano, type SpendLogLine } from './spend.js';

export type Env = Readonly<Record<string, string | undefined>>;

export const DEFAULT_STOP_FILE = '.claw-pay/LLM_STOP';
export const DEFAULT_SPEND_LOG = '.claw-pay/llm-spend.jsonl';

export interface EnvDeps {
  readonly fetch?: FetchLike;
  readonly fileExists?: (path: string) => boolean;
  readonly appendLine?: (path: string, line: string) => void;
  readonly clock?: () => number;
}

const set = (v: string | undefined): v is string => v !== undefined && v !== '';

function need(env: Env, name: string): string {
  const v = env[name];
  if (!set(v)) throw new LlmError(`LLM_CONFIG_MISSING:${name}`);
  return v;
}

function int(env: Env, name: string, dflt: number): number {
  const v = env[name];
  if (!set(v)) return dflt;
  if (!/^[1-9][0-9]{0,5}$/.test(v)) throw new LlmError(`LLM_CONFIG_BAD:${name}`);
  return Number(v);
}

/** The LLM agent is off unless ENABLE_LLM_AGENT=yes (PAYPAL_README "AI and PayPal tools used"). */
export function assertAgentEnabled(env: Env): void {
  if (env['ENABLE_LLM_AGENT'] !== 'yes') throw new LlmError('LLM_AGENT_DISABLED (set ENABLE_LLM_AGENT=yes)');
}

/** `runId` feeds the Flovia-Operation-Id (random when not given; fixed in tests). */
export function providerFromEnv(env: Env, fetch?: FetchLike, runId?: string): LlmProvider {
  const which = env['LLM_PROVIDER'];
  const f = fetch === undefined ? {} : { fetch };
  if (!set(which) || which === 'flovia') {
    return new FloviaProvider({
      apiKey: need(env, 'FLOVIA_API_KEY'),
      baseUrl: set(env['FLOVIA_BASE_URL']) ? env['FLOVIA_BASE_URL'] : FLOVIA_DEFAULT_BASE_URL,
      model: set(env['FLOVIA_MODEL']) ? env['FLOVIA_MODEL'] : FLOVIA_DEFAULT_MODEL,
      ...(runId === undefined ? {} : { runId }),
      ...f,
    });
  }
  if (which === 'anthropic') {
    return new AnthropicProvider({
      apiKey: need(env, 'ANTHROPIC_API_KEY'),
      model: set(env['ANTHROPIC_MODEL']) ? env['ANTHROPIC_MODEL'] : ANTHROPIC_DEFAULT_MODEL,
      ...f,
    });
  }
  throw new LlmError('LLM_PROVIDER_UNKNOWN');
}

const appendJsonl = (path: string, line: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${line}\n`, { mode: 0o600 });
};

export function spendGuardFromEnv(env: Env, deps: EnvDeps = {}): SpendGuard {
  const maxRun = usdToNano(set(env['LLM_MAX_RUN_USD']) ? env['LLM_MAX_RUN_USD'] : '0.05');
  if (maxRun === undefined) throw new LlmError('LLM_CONFIG_BAD:LLM_MAX_RUN_USD');
  const stopFile = set(env['LLM_STOP_FILE']) ? env['LLM_STOP_FILE'] : DEFAULT_STOP_FILE;
  const logPath = set(env['LLM_SPEND_LOG']) ? env['LLM_SPEND_LOG'] : DEFAULT_SPEND_LOG;
  const exists = deps.fileExists ?? existsSync;
  const append = deps.appendLine ?? appendJsonl;
  return new SpendGuard({
    limits: {
      maxTokens: int(env, 'LLM_MAX_TOKENS', 512),
      maxRunNanoUsd: maxRun,
      maxCalls: int(env, 'LLM_MAX_CALLS', 3),
    },
    // Read on every call, so setting the flag mid-run stops the next call.
    stopped: () => env['LLM_HARD_STOP'] === 'yes' || exists(stopFile),
    log: (line: SpendLogLine) => {
      append(logPath, JSON.stringify(line));
    },
    ...(deps.clock === undefined ? {} : { clock: deps.clock }),
  });
}
