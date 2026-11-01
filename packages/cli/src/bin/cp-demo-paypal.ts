#!/usr/bin/env node
// Runs the PayPal mock demo; exits non-zero on any mismatch.
import { runPaypalDemo } from '../demo-paypal.js';

process.exitCode = await runPaypalDemo((line) => {
  process.stdout.write(`${line}\n`);
});
