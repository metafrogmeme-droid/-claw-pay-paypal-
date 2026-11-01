// Recorded-response fetch for tests: no network. Each call is checked against the queue and recorded.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { FetchLike } from '../src/index.js';

export const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures', name), 'utf8')) as unknown;

export interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
  readonly redirect: string | undefined;
}

export function fakeFetch(replies: { status: number; body: unknown }[]): {
  fetch: FetchLike;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const queue = [...replies];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body, redirect: init.redirect });
    const next = queue.shift();
    if (!next) return Promise.reject(new Error('fakeFetch: no reply queued'));
    const text = typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
    return Promise.resolve({ status: next.status, text: () => Promise.resolve(text) });
  };
  return { fetch, calls };
}

export const TOKEN = { status: 200, body: fixture('oauth-token.json') };
