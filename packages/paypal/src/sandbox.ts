// Sandbox-only guard (docs/DECISIONS.md D-004).
// The toolkit ignores PAYPAL_ENVIRONMENT and defaults to LIVE, so we force and check sandbox ourselves.

export const SANDBOX_HOSTS = ['api-m.sandbox.paypal.com', 'api.sandbox.paypal.com'] as const;
export const LIVE_HOSTS = ['api-m.paypal.com', 'api.paypal.com', 'mcp.paypal.com'] as const;

export type GuardCode =
  'ERR_PRODUCTION_REFUSED' | 'ERR_HOST_REFUSED' | 'ERR_UNKNOWN_TOOL' | 'ERR_CONFIG' | 'ERR_RULES';

export class PaypalGuardError extends Error {
  constructor(
    readonly code: GuardCode,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

export function assertSandboxEnv(env: Readonly<Record<string, string | undefined>>): void {
  if (env['PAYPAL_ENVIRONMENT'] !== 'SANDBOX') {
    throw new PaypalGuardError('ERR_PRODUCTION_REFUSED', 'PAYPAL_ENVIRONMENT must be exactly SANDBOX');
  }
}

/** Throws unless `url` is https on one of the two sandbox API hosts, default port, no credentials. */
export function assertAllowedHost(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new PaypalGuardError('ERR_HOST_REFUSED', 'not a URL');
  }
  const ok =
    u.protocol === 'https:' &&
    u.port === '' &&
    u.username === '' &&
    u.password === '' &&
    (SANDBOX_HOSTS as readonly string[]).includes(u.hostname);
  if (!ok)
    throw new PaypalGuardError('ERR_HOST_REFUSED', `host ${u.hostname} is not a PayPal sandbox API host`);
}

/** Toolkit tool name → `configuration.actions[product][action]` key, from the shipped toolkit 1.11.0 code. */
export const TOOL_ACTIONS = {
  create_order: ['orders', 'create'],
  get_order: ['orders', 'get'],
  pay_order: ['orders', 'capture'],
  create_refund: ['payments', 'createRefund'],
  get_refund: ['payments', 'getRefunds'],
  list_transactions: ['transactions', 'list'],
  create_subscription: ['subscriptions', 'create'],
} as const satisfies Record<string, readonly [string, string]>;

export type ToolName = keyof typeof TOOL_ACTIONS;
export const TOOL_NAMES = Object.keys(TOOL_ACTIONS) as [ToolName, ...ToolName[]];

export interface ToolkitConfiguration {
  readonly actions: Record<string, Record<string, boolean>>;
  /** Always sandbox. Never a global request_id (it would make every order share one idempotency key). */
  readonly context: { readonly sandbox: true };
}

/** The toolkit `configuration` for exactly these tools (defence in depth: same set as the rules allowlist). */
export function toolkitConfiguration(tools: readonly string[]): ToolkitConfiguration {
  const actions: Record<string, Record<string, boolean>> = {};
  for (const tool of tools) {
    if (!Object.hasOwn(TOOL_ACTIONS, tool)) throw new PaypalGuardError('ERR_UNKNOWN_TOOL', tool);
    const [product, action] = TOOL_ACTIONS[tool as keyof typeof TOOL_ACTIONS];
    actions[product] = { ...actions[product], [action]: true };
  }
  return { actions, context: { sandbox: true } };
}
