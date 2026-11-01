// Test fixture. Spec examples copied from github.com/x402-foundation/x402 at commit
// e208bd39030be35a0f807eb3bf4f043354273866 (Apache-2.0): specs/transports-v2/http.md (PAYMENT-REQUIRED example)
// and specs/x402-specification-v1.md §5.1.1. The asset is the testnet (Base Sepolia) token from the spec.

export const SPEC_V2_HEADER =
  'eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJQQVlNRU5ULVNJR05BVFVSRSBoZWFkZXIgaXMgcmVxdWlyZWQiLCJyZXNvdXJjZSI6eyJ1cmwiOiJodHRwczovL2FwaS5leGFtcGxlLmNvbS9wcmVtaXVtLWRhdGEiLCJkZXNjcmlwdGlvbiI6IkFjY2VzcyB0byBwcmVtaXVtIG1hcmtldCBkYXRhIiwibWltZVR5cGUiOiJhcHBsaWNhdGlvbi9qc29uIn0sImFjY2VwdHMiOlt7InNjaGVtZSI6ImV4YWN0IiwibmV0d29yayI6ImVpcDE1NTo4NDUzMiIsImFtb3VudCI6IjEwMDAwIiwiYXNzZXQiOiIweDAzNkNiRDUzODQyYzU0MjY2MzRlNzkyOTU0MWVDMjMxOGYzZENGN2UiLCJwYXlUbyI6IjB4MjA5NjkzQmM2YWZjMEM1MzI4YkEzNkZhRjAzQzUxNEVGMzEyMjg3QyIsIm1heFRpbWVvdXRTZWNvbmRzIjo2MCwiZXh0cmEiOnsibmFtZSI6IlVTREMiLCJ2ZXJzaW9uIjoiMiJ9fV19';

export const SPEC_V1_BODY = JSON.stringify({
  x402Version: 1,
  error: 'X-PAYMENT header is required',
  accepts: [
    {
      scheme: 'exact',
      network: 'base-sepolia',
      maxAmountRequired: '10000',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
      resource: 'https://api.example.com/premium-data',
      description: 'Access to premium market data',
      mimeType: 'application/json',
      outputSchema: null,
      maxTimeoutSeconds: 60,
      extra: { name: 'USDC', version: '2' },
    },
  ],
});

/** Base64 of a JSON value, the way a server builds PAYMENT-REQUIRED. */
export const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v), 'utf8').toString('base64');

export const v2 = (
  accept: Record<string, unknown> = {},
  top: Record<string, unknown> = {},
): Record<string, unknown> => ({
  x402Version: 2,
  resource: { url: 'https://api.example.com/premium-data' },
  accepts: [
    {
      scheme: 'exact',
      network: 'eip155:84532',
      amount: '10000',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
      maxTimeoutSeconds: 60,
      ...accept,
    },
  ],
  ...top,
});
