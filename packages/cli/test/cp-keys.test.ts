// Tests for cp-keys (M1 acceptance checks).
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ENV_KEYS, runCpKeys, writeFileAtomic, type CpKeysIo } from '../src/cp-keys.js';

const HEX64 = /[0-9a-fA-F]{64}/;

let dir: string;
let out: string[];
let err: string[];

function io(env: Record<string, string | undefined> = {}): CpKeysIo {
  return { env, cwd: dir, stdout: (l) => out.push(l), stderr: (l) => err.push(l) };
}

function envFile(): string {
  return join(dir, '.env');
}

function parseEnv(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) m.set(line.slice(0, i), line.slice(i + 1));
  }
  return m;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cp-keys-'));
  out = [];
  err = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('cp-keys: testnet happy path', () => {
  it('writes budget, owner and guardian keys plus the chain id for Base Sepolia', async () => {
    const code = await runCpKeys(['--chain-id', '84532'], io());
    expect(code).toBe(0);
    const env = parseEnv(readFileSync(envFile(), 'utf8'));
    expect(env.get(ENV_KEYS.chainId)).toBe('84532');
    for (const k of [ENV_KEYS.budget, ENV_KEYS.owner, ENV_KEYS.guardian]) {
      expect(env.get(k)).toMatch(/^0x[0-9a-f]{64}$/);
    }
    const keys = new Set([env.get(ENV_KEYS.budget), env.get(ENV_KEYS.owner), env.get(ENV_KEYS.guardian)]);
    expect(keys.size).toBe(3);
  });

  it('accepts the local anvil chain id', async () => {
    expect(await runCpKeys(['--chain-id', '31337'], io())).toBe(0);
  });

  it('creates the .env file with mode 600', async () => {
    await runCpKeys(['--chain-id', '84532'], io());
    expect(statSync(envFile()).mode & 0o777).toBe(0o600);
  });

  it('prints the three addresses and never a private key, on stdout or stderr', async () => {
    await runCpKeys(['--chain-id', '84532'], io());
    const env = parseEnv(readFileSync(envFile(), 'utf8'));
    const printed = [...out, ...err].join('\n');
    for (const k of [ENV_KEYS.budget, ENV_KEYS.owner, ENV_KEYS.guardian]) {
      const pk = env.get(k) as `0x${string}`;
      expect(printed).not.toContain(pk.slice(2));
      expect(printed).toContain(privateKeyToAccount(pk).address);
    }
    expect(printed).not.toMatch(HEX64);
  });

  it('keeps unrelated lines of an existing .env exactly as they were', async () => {
    writeFileSync(envFile(), '# my settings\nPAYPAL_ENVIRONMENT=SANDBOX\nOTHER=1\n', { mode: 0o644 });
    expect(await runCpKeys(['--chain-id', '84532'], io())).toBe(0);
    const text = readFileSync(envFile(), 'utf8');
    expect(text.startsWith('# my settings\nPAYPAL_ENVIRONMENT=SANDBOX\nOTHER=1\n')).toBe(true);
    expect(statSync(envFile()).mode & 0o777).toBe(0o600);
  });

  it('uses --env-file when given', async () => {
    expect(await runCpKeys(['--chain-id', '84532', '--env-file', 'keys.env'], io())).toBe(0);
    expect(parseEnv(readFileSync(join(dir, 'keys.env'), 'utf8')).get(ENV_KEYS.chainId)).toBe('84532');
  });
});

describe('cp-keys: mainnet is refused', () => {
  it('refuses Ethereum mainnet (chain id 1) with ERR_MAINNET_REFUSED and writes nothing', async () => {
    expect(await runCpKeys(['--chain-id', '1'], io())).toBe(1);
    expect(err.join('\n')).toContain('ERR_MAINNET_REFUSED');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('treats an unknown chain id as mainnet (fail closed)', async () => {
    expect(await runCpKeys(['--chain-id', '999999'], io())).toBe(1);
    expect(err.join('\n')).toContain('ERR_MAINNET_REFUSED');
  });

  it('allows a mainnet id only with MAINNET_GO=yes exactly', async () => {
    expect(await runCpKeys(['--chain-id', '1'], io({ MAINNET_GO: 'YES' }))).toBe(1);
    expect(await runCpKeys(['--chain-id', '1'], io({ MAINNET_GO: 'true' }))).toBe(1);
    expect(readdirSync(dir)).toEqual([]);
    expect(await runCpKeys(['--chain-id', '1'], io({ MAINNET_GO: 'yes' }))).toBe(0);
  });

  it('does not treat CI=false or an empty CI as CI', async () => {
    expect(await runCpKeys(['--chain-id', '1'], io({ MAINNET_GO: 'yes', CI: 'false' }))).toBe(0);
    rmSync(envFile());
    expect(await runCpKeys(['--chain-id', '1'], io({ MAINNET_GO: 'yes', CI: '' }))).toBe(0);
  });

  it('refuses mainnet in CI even with MAINNET_GO=yes', async () => {
    expect(await runCpKeys(['--chain-id', '1'], io({ MAINNET_GO: 'yes', CI: 'true' }))).toBe(1);
    expect(err.join('\n')).toContain('ERR_MAINNET_REFUSED');
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('cp-keys: existing keys are protected', () => {
  async function seed(): Promise<string> {
    expect(await runCpKeys(['--chain-id', '84532'], io())).toBe(0);
    out = [];
    err = [];
    return readFileSync(envFile(), 'utf8');
  }

  it('refuses to overwrite existing keys without --force and leaves the file unchanged', async () => {
    const before = await seed();
    expect(await runCpKeys(['--chain-id', '84532'], io())).toBe(1);
    expect(err.join('\n')).toContain('ERR_KEYS_EXIST');
    expect(readFileSync(envFile(), 'utf8')).toBe(before);
  });

  it('refuses --force alone when an owner key exists', async () => {
    const before = await seed();
    expect(await runCpKeys(['--chain-id', '84532', '--force'], io())).toBe(1);
    expect(err.join('\n')).toContain('ERR_OWNER_KEY_PROTECTED');
    expect(readFileSync(envFile(), 'utf8')).toBe(before);
  });

  it('replaces all keys with --force --replace-owner-key', async () => {
    const before = parseEnv(await seed());
    expect(await runCpKeys(['--chain-id', '84532', '--force', '--replace-owner-key'], io())).toBe(0);
    const after = parseEnv(readFileSync(envFile(), 'utf8'));
    for (const k of [ENV_KEYS.budget, ENV_KEYS.owner, ENV_KEYS.guardian]) {
      expect(after.get(k)).not.toBe(before.get(k));
    }
  });

  it('with --force and no owner key, replaces budget and guardian keys', async () => {
    writeFileSync(envFile(), `${ENV_KEYS.budget}=0x${'1'.repeat(64)}\n`);
    expect(await runCpKeys(['--chain-id', '84532', '--force'], io())).toBe(0);
    expect(parseEnv(readFileSync(envFile(), 'utf8')).get(ENV_KEYS.budget)).not.toBe(`0x${'1'.repeat(64)}`);
  });

  it('treats an empty value as no key', async () => {
    writeFileSync(envFile(), `${ENV_KEYS.owner}=\n`);
    expect(await runCpKeys(['--chain-id', '84532'], io())).toBe(0);
    const env = readFileSync(envFile(), 'utf8');
    expect(env.split('\n').filter((l) => l.startsWith(`${ENV_KEYS.owner}=`))).toHaveLength(1);
  });

  it('refuses to write through a symlinked .env', async () => {
    writeFileSync(join(dir, 'target'), '');
    symlinkSync(join(dir, 'target'), envFile());
    expect(await runCpKeys(['--chain-id', '84532'], io())).toBe(1);
    expect(err.join('\n')).toContain('ERR_ENV_FILE_SYMLINK');
    expect(readFileSync(join(dir, 'target'), 'utf8')).toBe('');
  });
});

describe('cp-keys: env file problems', () => {
  it('refuses an env file path that is a directory', async () => {
    mkdirSync(join(dir, 'd'));
    expect(await runCpKeys(['--chain-id', '84532', '--env-file', 'd'], io())).toBe(1);
    expect(err.join('\n')).toContain('ERR_ENV_FILE_NOT_FILE');
  });

  it('reports other file errors as ERR_INTERNAL without echoing details', async () => {
    writeFileSync(join(dir, 'plain'), 'x');
    expect(await runCpKeys(['--chain-id', '84532', '--env-file', 'plain/.env'], io())).toBe(1);
    expect(err.join('\n')).toMatch(/ERR_INTERNAL: \w+$/);
  });
});

describe('cp-keys: arguments', () => {
  it.each([
    [[]],
    [['--chain-id']],
    [['--chain-id', 'abc']],
    [['--chain-id', '-5']],
    [['--chain-id', '1.5']],
    [['--chain-id', '84532', '--replace-owner-key']],
    [['--chain-id', '84532', '--bogus']],
    [['--chain-id', '84532', '--env-file']],
  ])('rejects %j with exit code 2 and ERR_BAD_ARGS', async (argv) => {
    expect(await runCpKeys(argv, io())).toBe(2);
    expect(err.join('\n')).toContain('ERR_BAD_ARGS');
    expect(readdirSync(dir)).toEqual([]);
  });

  it.each([['--help'], ['-h']])('prints usage for %s and exits 0', async (flag) => {
    expect(await runCpKeys([flag], io())).toBe(0);
    expect(out.join('\n')).toContain('Usage: cp-keys');
  });
});

describe('writeFileAtomic', () => {
  it('replaces a 644 file with a 600 file and leaves no temp file behind', async () => {
    const p = join(dir, 'f');
    writeFileSync(p, 'old', { mode: 0o644 });
    await writeFileAtomic(p, 'new');
    expect(readFileSync(p, 'utf8')).toBe('new');
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['f']);
  });

  it('removes the temp file when the rename fails', async () => {
    mkdirSync(join(dir, 'busy'));
    writeFileSync(join(dir, 'busy', 'x'), '');
    await expect(writeFileAtomic(join(dir, 'busy'), 'x')).rejects.toThrow();
    expect(readdirSync(dir)).toEqual(['busy']);
  });

  it('throws and leaves nothing behind when the directory does not exist', async () => {
    await expect(writeFileAtomic(join(dir, 'missing', 'f'), 'x')).rejects.toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });
});
