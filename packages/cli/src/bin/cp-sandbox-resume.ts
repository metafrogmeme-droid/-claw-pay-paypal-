#!/usr/bin/env node
// After the buyer approved: get_order re-check (APPROVED, your payee, same amount), then one capture.
import { runSandboxResume } from '../sandbox-resume.js';

process.exitCode = await runSandboxResume(process.argv.slice(2), process.env, (line) => {
  process.stdout.write(`${line}\n`);
});
