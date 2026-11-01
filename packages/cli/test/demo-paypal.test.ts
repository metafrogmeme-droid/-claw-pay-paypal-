// Acceptance test for `make demo-paypal` (docs/DEMO_SCRIPT.md): exact counts, mock only.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { runPaypalDemo } from '../src/demo-paypal.js';

describe('PayPal mock demo', () => {
  it('matches the DEMO_SCRIPT.md table and prints the exact OK line', async () => {
    const lines: string[] = [];
    const code = await runPaypalDemo((l) => lines.push(l));
    expect(code).toBe(0);
    expect(lines.at(-1)).toBe(
      'PAYPAL DEMO OK (5 allowed, 6 blocked, 1 needed your OK, 5 PayPal calls, 0 calls when blocked, pause works, creds isolated)',
    );
    expect(lines.join('\n')).not.toMatch(/MISMATCH:/);
  });

  it('exits non-zero and says FAILED when the rules no longer match the table', async () => {
    const path = resolve(import.meta.dirname, '../../../demo/paypal/rules.json');
    const file = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const lines: string[] = [];
    const code = await runPaypalDemo((l) => lines.push(l), { ...file, confirmThreshold: '1.00' } as never);
    expect(code).toBe(1);
    expect(lines.some((l) => l.startsWith('MISMATCH: row 1'))).toBe(true);
    expect(lines.at(-1)?.startsWith('PAYPAL DEMO FAILED')).toBe(true);
  });
});
