// Test doubles for the agent package: a scripted LLM provider and a recording fetch. No network.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { MockPaypal, PaypalGate, loadPaypalRules, type PaypalRulesFile } from '@claw-pay/paypal';

import type { ChatReply, ChatRequest, FetchLike, LlmProvider } from '../src/index.js';

export class ScriptedProvider implements LlmProvider {
  readonly name = 'mock' as const;
  readonly model = 'scripted';
  readonly price = { inputNanoUsd: 100n, outputNanoUsd: 500n };
  readonly seen: ChatRequest[] = [];
  constructor(private readonly reply: string | Error) {}
  complete(req: ChatRequest): Promise<ChatReply> {
    this.seen.push(req);
    if (this.reply instanceof Error) return Promise.reject(this.reply);
    return Promise.resolve({ text: this.reply, inputTokens: 1000, outputTokens: 100 });
  }
}

export interface Sent {
  readonly url: string;
  readonly init: RequestInit;
  readonly body: Record<string, unknown>;
  readonly headers: Record<string, string>;
}

/** One canned reply per call; records what was sent. */
export function cannedFetch(replies: (Response | Error)[]): { fetch: FetchLike; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetch: FetchLike = (url, init) => {
    sent.push({
      url,
      init,
      body: JSON.parse(init.body as string) as Record<string, unknown>,
      headers: init.headers as Record<string, string>,
    });
    const r = replies.shift();
    if (r === undefined) return Promise.reject(new Error('no canned reply'));
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  };
  return { fetch, sent };
}

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures', name), 'utf8'));

const NOW = Date.UTC(2026, 10, 4, 12);
const rulesFile = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../../demo/paypal/rules.json'), 'utf8'),
) as PaypalRulesFile;

export function demoGate(ownerSays = false): { mock: MockPaypal; gate: PaypalGate } {
  const mock = new MockPaypal();
  const { rules, config } = loadPaypalRules(rulesFile, NOW);
  const gate = new PaypalGate({
    rules,
    config,
    client: mock,
    clock: () => NOW,
    ownerOk: () => Promise.resolve(ownerSays),
  });
  return { mock, gate };
}
