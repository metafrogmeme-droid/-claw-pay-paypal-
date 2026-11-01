#!/usr/bin/env node
// One sandbox create_order through the gate; stops at the buyer step unless CP_SMOKE_WAIT_MINUTES is set.
import { runSandboxSmoke } from '../sandbox-smoke.js';

process.exitCode = await runSandboxSmoke(process.env, (line) => {
  process.stdout.write(`${line}\n`);
});
