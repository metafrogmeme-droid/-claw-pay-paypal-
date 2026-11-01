#!/usr/bin/env node
// Thin process wrapper around runCpKeys (logic and tests live in ../cp-keys.ts).
import { runCpKeys } from '../cp-keys.js';

const code = await runCpKeys(process.argv.slice(2), {
  env: process.env,
  cwd: process.cwd(),
  stdout: (line) => {
    process.stdout.write(`${line}\n`);
  },
  stderr: (line) => {
    process.stderr.write(`${line}\n`);
  },
});
process.exitCode = code;
