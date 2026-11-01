// cp-keys: generate testnet budget / owner / guardian keys into a local .env.
// Rules: refuse mainnet unless MAINNET_GO=yes on this machine (never in CI); never print a secret;
// .env mode 600, atomic write; never overwrite an owner key without --force --replace-owner-key.

import { randomBytes } from 'node:crypto';
import { constants as fsc } from 'node:fs';
import { lstat, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

export const ENV_KEYS = {
  chainId: 'CP_CHAIN_ID',
  budget: 'CP_BUDGET_PRIVATE_KEY',
  owner: 'CP_OWNER_PRIVATE_KEY',
  guardian: 'CP_GUARDIAN_PRIVATE_KEY',
} as const;

/**
 * Chain ids we know to be test networks. Every other id is treated as mainnet (fail closed).
 * 31337: local anvil. 84532: Base Sepolia (`eip155:84532`).
 * More testnets are added only from their official docs, never from memory.
 */
export const TESTNET_CHAIN_IDS: ReadonlySet<number> = new Set([31337, 84532]);

export interface CpKeysIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

interface Options {
  readonly chainId: number;
  readonly envFile: string;
  readonly force: boolean;
  readonly replaceOwnerKey: boolean;
}

type ParseResult = { kind: 'help' } | { kind: 'error'; message: string } | { kind: 'ok'; options: Options };

const USAGE = [
  'Usage: cp-keys --chain-id <id> [--env-file <path>] [--force] [--replace-owner-key]',
  '',
  'Generates testnet budget, owner and guardian keys into .env (mode 600). Prints addresses only.',
  `Known testnet chain ids: ${[...TESTNET_CHAIN_IDS].join(', ')}. Any other id is refused as mainnet`,
  'unless MAINNET_GO=yes is set on this machine (never in CI).',
].join('\n');

class CpKeysError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function parseArgs(argv: readonly string[]): ParseResult {
  let chainId: number | undefined;
  let envFile = '.env';
  let force = false;
  let replaceOwnerKey = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    switch (arg) {
      case '--help':
      case '-h':
        return { kind: 'help' };
      case '--force':
        force = true;
        break;
      case '--replace-owner-key':
        replaceOwnerKey = true;
        break;
      case '--chain-id': {
        const v = argv[++i];
        if (v === undefined || !/^[1-9][0-9]{0,15}$/.test(v)) {
          return { kind: 'error', message: '--chain-id needs a positive integer' };
        }
        chainId = Number(v);
        break;
      }
      case '--env-file': {
        const v = argv[++i];
        if (v === undefined || v === '') return { kind: 'error', message: '--env-file needs a path' };
        envFile = v;
        break;
      }
      default:
        return { kind: 'error', message: `unknown argument: ${arg}` };
    }
  }
  if (chainId === undefined) return { kind: 'error', message: '--chain-id is required' };
  if (replaceOwnerKey && !force) return { kind: 'error', message: '--replace-owner-key needs --force' };
  return { kind: 'ok', options: { chainId, envFile, force, replaceOwnerKey } };
}

function checkNetwork(chainId: number, env: CpKeysIo['env']): void {
  if (TESTNET_CHAIN_IDS.has(chainId)) return;
  const ci = env['CI'];
  if (ci !== undefined && ci !== '' && ci !== 'false') {
    throw new CpKeysError(
      'ERR_MAINNET_REFUSED',
      `chain ${String(chainId)} is not a known testnet; refused in CI`,
    );
  }
  if (env['MAINNET_GO'] !== 'yes') {
    throw new CpKeysError(
      'ERR_MAINNET_REFUSED',
      `chain ${String(chainId)} is not a known testnet; set MAINNET_GO=yes on this machine to allow it`,
    );
  }
}

async function readExisting(path: string): Promise<string> {
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink()) {
      throw new CpKeysError(
        'ERR_ENV_FILE_SYMLINK',
        'the env file is a symlink; refusing to write keys through it',
      );
    }
    if (!st.isFile()) throw new CpKeysError('ERR_ENV_FILE_NOT_FILE', 'the env file is not a regular file');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw e;
  }
  return readFile(path, 'utf8');
}

function hasValue(lines: readonly string[], key: string): boolean {
  return lines.some((l) => l.startsWith(`${key}=`) && l.slice(key.length + 1).trim() !== '');
}

/** Replace `KEY=...` lines for managed keys, keep everything else verbatim, append missing keys. */
function mergeEnv(existing: string, values: ReadonlyMap<string, string>): string {
  const lines = existing === '' ? [] : existing.replace(/\n$/, '').split('\n');
  const written = new Set<string>();
  const merged = lines.flatMap((line) => {
    const key = line.slice(0, Math.max(0, line.indexOf('=')));
    const v = values.get(key);
    if (v === undefined) return [line];
    if (written.has(key)) return [];
    written.add(key);
    return [`${key}=${v}`];
  });
  for (const [k, v] of values) if (!written.has(k)) merged.push(`${k}=${v}`);
  return `${merged.join('\n')}\n`;
}

/** Write `data` to `path` atomically with mode 600: temp file in the same directory, fsync, rename. */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  const tmp = resolve(dirname(path), `.${basename(path)}.tmp-${randomBytes(6).toString('hex')}`);
  const fh = await open(tmp, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL, 0o600);
  try {
    await fh.chmod(0o600);
    await fh.writeFile(data, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/** Runs cp-keys. Returns the process exit code: 0 ok, 1 refused, 2 bad arguments. */
export async function runCpKeys(argv: readonly string[], io: CpKeysIo): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.kind === 'help') {
    io.stdout(USAGE);
    return 0;
  }
  if (parsed.kind === 'error') {
    io.stderr(`cp-keys: ERR_BAD_ARGS: ${parsed.message}`);
    io.stderr(USAGE);
    return 2;
  }
  const { chainId, envFile, force, replaceOwnerKey } = parsed.options;
  const path = resolve(io.cwd, envFile);
  try {
    checkNetwork(chainId, io.env);
    const existing = await readExisting(path);
    const lines = existing.split('\n');
    const present = [ENV_KEYS.budget, ENV_KEYS.owner, ENV_KEYS.guardian].filter((k) => hasValue(lines, k));
    if (present.length > 0 && !force) {
      throw new CpKeysError(
        'ERR_KEYS_EXIST',
        `${envFile} already has ${present.join(', ')}; nothing changed`,
      );
    }
    if (present.includes(ENV_KEYS.owner) && !replaceOwnerKey) {
      throw new CpKeysError(
        'ERR_OWNER_KEY_PROTECTED',
        'an owner key exists; replacing it needs --force --replace-owner-key',
      );
    }
    const roles = [
      ['budget', ENV_KEYS.budget],
      ['owner', ENV_KEYS.owner],
      ['guardian', ENV_KEYS.guardian],
    ] as const;
    const values = new Map<string, string>([[ENV_KEYS.chainId, String(chainId)]]);
    const addresses: string[] = [];
    for (const [role, key] of roles) {
      const pk = generatePrivateKey();
      values.set(key, pk);
      addresses.push(`${role.padEnd(8)} ${privateKeyToAccount(pk).address}`);
    }
    await writeFileAtomic(path, mergeEnv(existing, values));
    io.stdout(`cp-keys: wrote 3 keys to ${envFile} (mode 600) for chain ${String(chainId)}`);
    for (const line of addresses) io.stdout(line);
    if (!TESTNET_CHAIN_IDS.has(chainId)) {
      io.stderr(`cp-keys: warning: chain ${String(chainId)} is not a known testnet (MAINNET_GO=yes)`);
    }
    return 0;
  } catch (e) {
    if (e instanceof CpKeysError) {
      io.stderr(`cp-keys: ${e.code}: ${e.message}`);
      return 1;
    }
    // Never echo unknown error objects verbatim: they could carry file contents.
    io.stderr(`cp-keys: ERR_INTERNAL: ${e instanceof Error ? e.name : 'unknown error'}`);
    return 1;
  }
}
