// Keeps the public docs in line with the code: the sandbox host lists, the demo's
// expected last line, and no dead relative links in README.md or docs/*.md.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { LIVE_HOSTS, SANDBOX_HOSTS } from '@claw-pay/paypal';

const ROOT = resolve(import.meta.dirname, '..');
/** @param {string} rel */
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');
const readme = read('README.md');
const DEMO_LINE =
  'PAYPAL DEMO OK (5 allowed, 6 blocked, 1 needed your OK, 5 PayPal calls, 0 calls when blocked, pause works, creds isolated)';

describe('README.md matches the code', () => {
  it('names every refused live host and every allowed sandbox host', () => {
    for (const host of [...LIVE_HOSTS, ...SANDBOX_HOSTS]) expect(readme).toContain(`\`${host}\``);
    expect(readme).toContain('context.sandbox: true');
  });

  it('shows the same expected demo line as docs/DEMO_SCRIPT.md', () => {
    expect(readme).toContain(DEMO_LINE);
    expect(read('docs/DEMO_SCRIPT.md')).toContain(DEMO_LINE);
  });

  it('uses the three verdict strings', () => {
    for (const v of ['Allowed: within your limits', 'Blocked by your rule: …', 'Needs your OK: …']) {
      expect(readme).toContain(v);
    }
  });
});

describe('docs links', () => {
  const docs = [
    'README.md',
    ...readdirSync(resolve(ROOT, 'docs'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => `docs/${f}`),
  ];
  it.each(docs)('%s has no dead relative links', (file) => {
    const text = read(file);
    for (const m of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
      const target = m[1] ?? '';
      if (/^[a-z]+:/i.test(target)) continue; // external URL
      expect(existsSync(resolve(ROOT, dirname(file), target)), `${file} → ${target}`).toBe(true);
    }
  });
});
