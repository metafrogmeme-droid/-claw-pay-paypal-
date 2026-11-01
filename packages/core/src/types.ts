// Input types of the rule core. Amounts are bigint atomic units, never floats.

/** A payment the agent wants to make, normalised by an adapter (x402, PayPal). */
export interface PaymentIntent {
  readonly sellerOrigin: string;
  readonly resourceUrl: string;
  /** CAIP-2 shaped, e.g. `eip155:84532` or `paypal:sandbox` (D-019). */
  readonly network: string;
  /** EVM: token contract address. `paypal:*` networks only: ISO-4217 code (D-019). */
  readonly asset: string;
  readonly amount: bigint;
  readonly payTo: string;
  readonly scheme: string;
  /** ms since epoch when the quote was read. */
  readonly quoteTime: number;
  /** The tool or action, e.g. `pay` (x402) or `create_order` (PayPal). */
  readonly action: string;
  /** The seller's declared or probed price, for the quote-drift rule. */
  readonly declaredAmount?: bigint;
}

export interface SellerRule {
  readonly origin: string;
  readonly payTo: string;
  readonly perCallCap?: bigint;
  readonly dailyCap?: bigint;
}

export interface Rules {
  readonly version: 1;
  readonly sellers: readonly SellerRule[];
  readonly perCallCap: bigint;
  readonly dailyCap: bigint;
  readonly maxPaymentsPerDay: number;
  readonly networks: readonly string[];
  /** Caps are in this asset's atomic units; keep one decimals scale per rule set. */
  readonly assets: readonly { readonly network: string; readonly asset: string }[];
  readonly confirmThreshold: bigint;
  /** Max price rise over the declared price, in basis points. */
  readonly quoteDriftBps: number;
  /** ms since epoch; at or after this, everything is RULES_EXPIRED. */
  readonly expiresAt: number;
  readonly actions: readonly string[];
}

export interface DecideOptions {
  /** The owner approved this exact intent: clears NEEDS_OWNER_OK outcomes, never a block. */
  readonly ownerApproved?: boolean;
  /** Result of the gate's unpaid probe; `false` blocks with PROBE_FAILED. */
  readonly probeOk?: boolean;
}
