// Exact decimal → minor units (cents). Never floats in our maths.

const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/;

/**
 * Parse a non-negative amount with at most 2 decimals into minor units.
 * Numbers use their shortest round-trip string (so 0.1 → "0.1" → 10n); exponents, signs, NaN, more than
 * 2 decimals or a non-number/string → undefined (the caller fails closed).
 */
export function toMinorUnits(value: unknown): bigint | undefined {
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return undefined;
    text = String(value);
  } else if (typeof value === 'string') {
    text = value;
  } else {
    return undefined;
  }
  if (!DECIMAL.test(text)) return undefined;
  const [whole, frac = ''] = text.split('.') as [string, string?];
  return BigInt(whole) * 100n + BigInt(frac.padEnd(2, '0'));
}

/** Minor units → "1234.56". */
export function formatMinor(minor: bigint): string {
  return `${String(minor / 100n)}.${String(minor % 100n).padStart(2, '0')}`;
}
