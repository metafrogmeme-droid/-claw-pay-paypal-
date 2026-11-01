// LLM providers behind one small interface. Flovia (OpenAI Responses API) is the default; Anthropic is used only
// when LLM_PROVIDER=anthropic. There is no automatic fallback from one to the other (D-025).
import { randomUUID } from 'node:crypto';

import { z } from 'zod';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ChatRequest {
  readonly system: string;
  readonly user: string;
  readonly maxTokens: number;
}

export interface ChatReply {
  readonly text: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Set when the provider stopped early (e.g. 'max_output_tokens'). The spend guard logs it, then refuses. */
  readonly incomplete?: string;
  /** The idempotency id sent with the call (Flovia-Operation-Id), for the spend log. */
  readonly operationId?: string;
}

/** Price per token in nano-USD (1e-9 USD), so every cost sum stays an exact bigint. */
export interface TokenPrice {
  readonly inputNanoUsd: bigint;
  readonly outputNanoUsd: bigint;
}

export interface LlmProvider {
  readonly name: 'flovia' | 'anthropic' | 'mock';
  readonly model: string;
  readonly price: TokenPrice;
  complete(req: ChatRequest): Promise<ChatReply>;
}

/** An LLM call that failed. The code never carries the provider's error text or any key. */
export class LlmError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const TIMEOUT_MS = 30_000;

/** The one network path for providers: https only, a fixed timeout, any failure → LlmError. */
async function postJson(fetch: FetchLike, url: string, headers: Record<string, string>, body: unknown) {
  if (!url.startsWith('https://')) throw new LlmError('LLM_URL_NOT_HTTPS');
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new LlmError('LLM_NETWORK_FAILED');
  }
  if (!res.ok) throw new LlmError(`LLM_HTTP_${String(res.status)}${await errorCode(res)}`);
  try {
    return await res.json();
  } catch {
    throw new LlmError('LLM_REPLY_UNREADABLE');
  }
}

/** A short machine code from an error body ({error:{code|type}}), never its message. '' when absent. */
async function errorCode(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { code?: unknown; type?: unknown } };
    const c = body.error?.code ?? body.error?.type;
    return typeof c === 'string' && CODE.test(c) ? `:${c}` : '';
  } catch {
    return '';
  }
}

const CODE = /^[a-z][a-z0-9_]{0,63}$/;

function check<T>(schema: z.ZodType<T>, value: unknown): T {
  try {
    return schema.parse(value);
  } catch {
    throw new LlmError('LLM_REPLY_UNREADABLE');
  }
}

const tokens = z.number().int().nonnegative();
const floviaReply = z.object({
  status: z.string(),
  incomplete_details: z.object({ reason: z.string().optional() }).nullish(),
  error: z.object({ code: z.string().optional() }).nullish(),
  output: z.array(
    z.object({
      type: z.string(),
      content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
    }),
  ),
  usage: z.object({ input_tokens: tokens, output_tokens: tokens }),
});

export const FLOVIA_DEFAULT_BASE_URL = 'https://api.flovia.dev/openai/v1';
export const FLOVIA_DEFAULT_MODEL = 'gpt-6-luna';
/** Flovia-Operation-Id is 8-128 chars of A-Z a-z 0-9 _ . : - ; `claw-pay:<runId>:<n>` stays inside that. */
const RUN_ID = /^[A-Za-z0-9_.-]{1,100}$/;

export interface FloviaOptions {
  readonly apiKey: string;
  /** Responses API base URL, e.g. https://api.flovia.dev/openai/v1 (no trailing /responses). */
  readonly baseUrl: string;
  readonly model: string;
  /** One id per agent run. The operation id is `claw-pay:<runId>:<call n>`. Random when not given. */
  readonly runId?: string;
  readonly fetch?: FetchLike;
}

/**
 * Flovia via its OpenAI Responses endpoint (POST {base}/responses). Free to use, so the price is zero.
 * Every call sends a Flovia-Operation-Id that is unique per generation. We never retry, so each call is a
 * new generation with a new id. The relay takes a single text input, so system and user are joined.
 */
export class FloviaProvider implements LlmProvider {
  readonly name = 'flovia' as const;
  readonly model: string;
  readonly price: TokenPrice = { inputNanoUsd: 0n, outputNanoUsd: 0n };
  readonly #key: string;
  readonly #url: string;
  readonly #fetch: FetchLike;
  readonly #runId: string;
  #calls = 0;

  constructor(o: FloviaOptions) {
    if (o.apiKey === '') throw new LlmError('LLM_CONFIG');
    if (!o.baseUrl.startsWith('https://')) throw new LlmError('LLM_URL_NOT_HTTPS');
    const runId = o.runId ?? randomUUID();
    if (!RUN_ID.test(runId)) throw new LlmError('LLM_CONFIG_BAD:runId');
    this.#key = o.apiKey;
    this.#url = `${o.baseUrl.replace(/\/+$/, '')}/responses`;
    this.model = o.model;
    this.#runId = runId;
    this.#fetch = o.fetch ?? globalThis.fetch;
  }

  async complete(req: ChatRequest): Promise<ChatReply> {
    this.#calls++;
    const operationId = `claw-pay:${this.#runId}:${String(this.#calls)}`;
    const json = await postJson(
      this.#fetch,
      this.#url,
      { Authorization: `Bearer ${this.#key}`, 'Flovia-Operation-Id': operationId },
      {
        model: this.model,
        input: `${req.system}\n\n${req.user}`,
        max_output_tokens: req.maxTokens,
        reasoning: { effort: 'none' },
        text: { format: { type: 'json_object' } },
      },
    );
    const r = check(floviaReply, json);
    if (r.status !== 'completed' && r.status !== 'incomplete') {
      const status = CODE.test(r.status) ? r.status.toUpperCase() : 'UNKNOWN';
      const err = r.error?.code;
      throw new LlmError(`LLM_STATUS_${status}${err !== undefined && CODE.test(err) ? `:${err}` : ''}`);
    }
    const text = r.output
      .filter((o) => o.type === 'message')
      .flatMap((o) => o.content ?? [])
      .filter((c) => c.type === 'output_text')
      .map((c) => c.text ?? '')
      .join('');
    const reply = {
      text,
      inputTokens: r.usage.input_tokens,
      outputTokens: r.usage.output_tokens,
      operationId,
    };
    if (r.status === 'completed') return reply;
    const reason = r.incomplete_details?.reason;
    return { ...reply, incomplete: reason !== undefined && CODE.test(reason) ? reason : 'unknown' };
  }

  toJSON(): { name: string; model: string } {
    return { name: this.name, model: this.model };
  }
}

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
/**
 * The cheap default. Model id checked live on 1 Nov 2026 (/v1/models and a Messages call). Price from
 * anthropic.com/pricing on 1 Nov 2026, Haiku 5.5, prompts ≤ 100K tokens: 0.10 in, 0.50 out (USD per million
 * tokens). Our prompts are far below 100K; the > 100K tier is not modelled.
 */
export const ANTHROPIC_DEFAULT_MODEL = 'claude-haiku-5-5';
export const ANTHROPIC_DEFAULT_PRICE: TokenPrice = { inputNanoUsd: 100n, outputNanoUsd: 500n };

const anthropicReply = z.object({
  stop_reason: z.string().nullish(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  usage: z.object({ input_tokens: tokens, output_tokens: tokens }),
});

export interface AnthropicOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly price?: TokenPrice;
  readonly fetch?: FetchLike;
}

/** Anthropic Messages API. Only built when LLM_PROVIDER=anthropic. */
export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic' as const;
  readonly model: string;
  readonly price: TokenPrice;
  readonly #key: string;
  readonly #fetch: FetchLike;

  constructor(o: AnthropicOptions) {
    if (o.apiKey === '') throw new LlmError('LLM_CONFIG');
    this.#key = o.apiKey;
    this.model = o.model ?? ANTHROPIC_DEFAULT_MODEL;
    this.price = o.price ?? ANTHROPIC_DEFAULT_PRICE;
    this.#fetch = o.fetch ?? globalThis.fetch;
  }

  async complete(req: ChatRequest): Promise<ChatReply> {
    const json = await postJson(
      this.#fetch,
      ANTHROPIC_URL,
      { 'x-api-key': this.#key, 'anthropic-version': '2023-06-01' },
      {
        model: this.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
      },
    );
    const r = check(anthropicReply, json);
    const text = r.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('');
    const reply = { text, inputTokens: r.usage.input_tokens, outputTokens: r.usage.output_tokens };
    // Cut off at max_tokens: the spend guard logs it, then refuses the half reply (same as Flovia 'incomplete').
    return r.stop_reason === 'max_tokens' ? { ...reply, incomplete: 'max_tokens' } : reply;
  }

  toJSON(): { name: string; model: string } {
    return { name: this.name, model: this.model };
  }
}
