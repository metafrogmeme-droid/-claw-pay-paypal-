#!/usr/bin/env node
// One LLM shopping-agent run through the gate. Mock PayPal unless --sandbox.
import { runAgentCli } from '../agent-run.js';

process.exitCode = await runAgentCli(process.argv.slice(2), process.env, (line) => {
  process.stdout.write(`${line}\n`);
});
