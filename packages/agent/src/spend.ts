// Spend guard for LLM calls: a max_tokens cap, a per-run USD cap, a call cap, a hard stop flag, and a JSONL
// spend log. Costs are bigint nano-USD. The log holds counts and costs only: no prompts, replies or keys.
import { LlmError, type ChatReply, type LlmProvider } from './providers.js';

export const MAX_TOKENS_HARD_CAP = 1024;

export interface SpendLimits {
  /** Output token cap per call (≤ MAX_TOKENS_HARD_CAP). */
  readonly maxTokens: number;
  /** Per-run cap in nano-USD, checked against the worst case BEFORE each call. */
  readonly maxRunNanoUsd: bigint;
  readonly maxCalls: number;
}

export interface SpendLogLine {
  readonly at: string;
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costNanoUsd: string;
  readonly runTotalNanoUsd: string;
  readonly status: 'completed' | 'incomplete';
  readonly operationId?: string;
}

export interface SpendGuardOptions {
  readonly limits: SpendLimits;
  /** True when the hard stop flag is set. Checked before every call. */
  readonly stopped: () => boolean;
  readonly log: (line: SpendLogLine) => void;
  readonly clock?: () => number;
}

/** Rough upper bound on input tokens: one token per 3 characters, plus a margin. */
export const estimateInputTokens = (text: string): number => Math.ceil(text.length / 3) + 64;

export const costNanoUsd = (p: LlmProvider['price'], input: number, output: number): bigint =>
  p.inputNanoUsd * BigInt(input) + p.outputNanoUsd * BigInt(output);

export class SpendGuard {
  readonly #o: SpendGuardOptions;
  #spent = 0n;
  #calls = 0;

  constructor(o: SpendGuardOptions) {
    if (!Number.isInteger(o.limits.maxTokens) || o.limits.maxTokens < 1) throw new LlmError('LLM_CONFIG');
    if (o.limits.maxTokens > MAX_TOKENS_HARD_CAP) throw new LlmError('LLM_CONFIG');
    if (o.limits.maxRunNanoUsd < 0n || !Number.isInteger(o.limits.maxCalls) || o.limits.maxCalls < 1) {
      throw new LlmError('LLM_CONFIG');
    }
    this.#o = o;
  }

  get spentNanoUsd(): bigint {
    return this.#spent;
  }

  get calls(): number {
    return this.#calls;
  }

  /** One guarded call: refuse before sending if stopped, out of calls, or the worst case would pass the cap. */
  async complete(provider: LlmProvider, system: string, user: string): Promise<ChatReply> {
    const { maxTokens, maxRunNanoUsd, maxCalls } = this.#o.limits;
    if (this.#o.stopped()) throw new LlmError('LLM_HARD_STOP');
    if (this.#calls >= maxCalls) throw new LlmError('LLM_CALL_CAP');
    const worst = costNanoUsd(provider.price, estimateInputTokens(system + user), maxTokens);
    if (this.#spent + worst > maxRunNanoUsd) throw new LlmError('LLM_RUN_CAP');
    this.#calls++;
    const reply = await provider.complete({ system, user, maxTokens });
    const cost = costNanoUsd(provider.price, reply.inputTokens, reply.outputTokens);
    this.#spent += cost;
    this.#o.log({
      at: new Date((this.#o.clock ?? Date.now)()).toISOString(),
      provider: provider.name,
      model: provider.model,
      inputTokens: reply.inputTokens,
      outputTokens: reply.outputTokens,
      costNanoUsd: String(cost),
      runTotalNanoUsd: String(this.#spent),
      status: reply.incomplete === undefined ? 'completed' : 'incomplete',
      ...(reply.operationId === undefined ? {} : { operationId: reply.operationId }),
    });
    // Tokens of a cut-off reply are logged and counted, but the reply is not used.
    if (reply.incomplete !== undefined) throw new LlmError(`LLM_REPLY_INCOMPLETE:${reply.incomplete}`);
    return reply;
  }
}

/** "0.05" → 50_000_000n nano-USD. At most 9 decimals; anything else → undefined. */
export function usdToNano(text: string): bigint | undefined {
  if (!/^(?:0|[1-9][0-9]{0,5})(?:\.[0-9]{1,9})?$/.test(text)) return undefined;
  const [whole = '0', frac = ''] = text.split('.');
  return BigInt(whole) * 1_000_000_000n + BigInt(frac.padEnd(9, '0'));
}
