/** Operator-only backup encryption. The 32-byte key must be stored separately from backups. */
import {
  type CipherGCM,
  createCipheriv,
  createDecipheriv,
  type DecipherGCM,
  randomBytes,
} from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { assertOperatorExecution } from './operator-only';
import { assertPrivateFile } from './secret-files.js';

// Versioned wire format: magic | 12-byte nonce | ciphertext | 16-byte GCM tag.
const MAGIC = Buffer.from('SAMBAK01');
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const CHUNK_BYTES = 64 * 1024;
const MANIFEST = '.sam-backup-manifest';

/** Raw random bytes, not a password or hex string. Never print the returned buffer. */
export function readBackupKey(keyFile: string): Buffer {
  assertOperatorExecution();
  if (realpathSync(keyFile) !== resolve(keyFile))
    throw new Error('Backup key must not use symlinks');
  assertPrivateFile(keyFile);
  const fd = openSync(keyFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size !== KEY_BYTES ||
      (process.getuid !== undefined && stat.uid !== process.getuid())
    ) {
      throw new Error(
        'Backup key must be a mode-0600 regular file containing exactly 32 random bytes'
      );
    }
    return readExact(fd, KEY_BYTES, 0);
  } finally {
    closeSync(fd);
  }
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function prepare(source: string, destination: string, keyFile: string): Buffer {
  assertOperatorExecution();
  if (realpathSync(source) !== resolve(source) || !lstatSync(source).isDirectory()) {
    throw new Error('Backup source must be a directory without symlinks');
  }
  if (existsSync(destination)) throw new Error('Backup destination must not already exist');
  if (realpathSync(dirname(resolve(destination))) !== dirname(resolve(destination))) {
    throw new Error('Backup destination parent must not use symlinks');
  }
  if (
    within(resolve(source), resolve(destination)) ||
    within(resolve(destination), resolve(source))
  ) {
    throw new Error('Backup source and destination must not overlap');
  }
  const keyPath = realpathSync(keyFile);
  if (within(resolve(source), keyPath) || within(resolve(destination), keyPath)) {
    throw new Error('Store the backup key separately from the backup trees');
  }
  return readBackupKey(keyFile);
}

interface Tree {
  files: string[];
  directories: string[];
}
function scan(root: string): Tree {
  const tree: Tree = { files: [], directories: [] };
  const visit = (dir: string): void => {
    for (const name of readdirSync(join(root, dir)).sort()) {
      const path = dir ? `${dir}/${name}` : name;
      const stat = lstatSync(join(root, path));
      if (stat.isDirectory()) {
        tree.directories.push(path);
        visit(path);
      } else if (stat.isFile() && stat.nlink === 1) tree.files.push(path);
      else throw new Error('Backup tree contains a symlink, hard link or special file');
    }
  };
  visit('');
  return tree;
}

function aad(header: Buffer, path: string): Buffer {
  return Buffer.concat([header, Buffer.from(`\0${path}`, 'utf8')]);
}
function header(): Buffer {
  return Buffer.concat([MAGIC, randomBytes(NONCE_BYTES)]);
}
function writeAll(fd: number, data: Buffer): void {
  let offset = 0;
  while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
}
function readExact(fd: number, size: number, position: number): Buffer {
  const data = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const n = readSync(fd, data, offset, size - offset, position + offset);
    if (n === 0) throw new Error('Truncated encrypted backup');
    offset += n;
  }
  return data;
}

/** Bounded memory even for database/object archives larger than the operator's RAM. */
function transformFile(
  source: string,
  destination: string,
  path: string,
  key: Buffer,
  decrypt: boolean,
  snapshot = ''
): void {
  assertOperatorExecution();
  const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output: number | undefined;
  try {
    const stat = fstatSync(input);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Backup input must be a regular file');
    const prefix = decrypt ? readExact(input, MAGIC.length + NONCE_BYTES, 0) : header();
    if (!prefix.subarray(0, MAGIC.length).equals(MAGIC))
      throw new Error('Unknown backup encryption format');
    const nonce = prefix.subarray(MAGIC.length);
    const cipher = decrypt
      ? createDecipheriv('aes-256-gcm', key, nonce)
      : createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad(prefix, `${snapshot}\0${path}`));
    let position = decrypt ? prefix.length : 0;
    const end = decrypt ? stat.size - TAG_BYTES : stat.size;
    if (end < position) throw new Error('Truncated encrypted backup');
    if (decrypt) (cipher as DecipherGCM).setAuthTag(readExact(input, TAG_BYTES, end));
    output = openSync(destination, 'wx', 0o600);
    if (!decrypt) writeAll(output, prefix);
    const chunk = Buffer.alloc(CHUNK_BYTES);
    while (position < end) {
      const count = readSync(input, chunk, 0, Math.min(chunk.length, end - position), position);
      if (count === 0) throw new Error('Backup input changed during encryption');
      writeAll(output, cipher.update(chunk.subarray(0, count)));
      position += count;
    }
    writeAll(output, cipher.final());
    if (!decrypt) writeAll(output, (cipher as CipherGCM).getAuthTag());
  } finally {
    closeSync(input);
    if (output !== undefined) closeSync(output);
  }
}

function sealManifest(tree: Tree, snapshot: string, key: Buffer, executable: string): Buffer {
  const prefix = header();
  const cipher = createCipheriv('aes-256-gcm', key, prefix.subarray(MAGIC.length));
  cipher.setAAD(aad(prefix, `\0${MANIFEST}`));
  return Buffer.concat([
    prefix,
    cipher.update(JSON.stringify({ snapshot, tree, executable })),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
}

/** Destination is new, private, and contains ciphertext only, including an authenticated inventory. */
export function encryptBackupTree(source: string, destination: string, keyFile: string): void {
  assertOperatorExecution();
  const key = prepare(source, destination, keyFile);
  let created = false;
  try {
    const tree = scan(source);
    const snapshot = randomBytes(16).toString('hex');
    if (tree.files.includes(MANIFEST) || tree.directories.includes(MANIFEST))
      throw new Error('Reserved backup manifest name');
    mkdirSync(destination, { mode: 0o700 });
    created = true;
    for (const dir of tree.directories) mkdirSync(join(destination, dir), { mode: 0o700 });
    for (const file of tree.files)
      transformFile(join(source, file), join(destination, file), file, key, false, snapshot);
    const executable = tree.files
      .map((file) => (lstatSync(join(source, file)).mode & 0o100 ? '1' : '0'))
      .join('');
    writeFileSync(join(destination, MANIFEST), sealManifest(tree, snapshot, key, executable), {
      mode: 0o600,
      flag: 'wx',
    });
  } catch {
    if (created) rmSync(destination, { recursive: true, force: true });
    throw new Error('Backup encryption failed; incomplete output removed');
  } finally {
    key.fill(0);
  }
}

/**
 * Decrypt into a NEW private scratch directory. Nothing may restore from it until this returns:
 * GCM authenticates at end-of-file, and every file and the full inventory must pass first.
 * The caller must remove the plaintext scratch directory after restore, including on failure.
 */
export function decryptBackupTree(source: string, destination: string, keyFile: string): void {
  assertOperatorExecution();
  const key = prepare(source, destination, keyFile);
  let created = false;
  try {
    const tree = scan(source);
    if (!tree.files.includes(MANIFEST)) throw new Error('Missing encrypted inventory');
    // Bound manifest plaintext to the actual inventory size, even for untrusted input.
    const inventory = {
      files: tree.files.filter((f) => f !== MANIFEST),
      directories: tree.directories,
    };
    const expected = JSON.stringify(inventory);
    const manifestSizes = [undefined, '0'.repeat(inventory.files.length)].map(
      (executable) =>
        Buffer.byteLength(
          JSON.stringify({ snapshot: '0'.repeat(32), tree: inventory, executable })
        ) +
        MAGIC.length +
        NONCE_BYTES +
        TAG_BYTES
    );
    if (!manifestSizes.includes(lstatSync(join(source, MANIFEST)).size))
      throw new Error('Backup inventory size mismatch');
    mkdirSync(destination, { mode: 0o700 });
    created = true;
    transformFile(join(source, MANIFEST), join(destination, MANIFEST), MANIFEST, key, true);
    // Compare canonical JSON, never trust manifest paths for filesystem operations.
    const manifest: unknown = JSON.parse(readFileSync(join(destination, MANIFEST), 'utf8'));
    if (
      typeof manifest !== 'object' ||
      manifest === null ||
      !('snapshot' in manifest) ||
      typeof manifest.snapshot !== 'string' ||
      !/^[a-f0-9]{32}$/.test(manifest.snapshot) ||
      !('tree' in manifest) ||
      JSON.stringify(manifest.tree) !== expected ||
      ('executable' in manifest &&
        (typeof manifest.executable !== 'string' ||
          manifest.executable.length !== inventory.files.length ||
          [...manifest.executable].some((bit) => bit !== '0' && bit !== '1')))
    ) {
      throw new Error('Backup inventory mismatch');
    }
    rmSync(join(destination, MANIFEST));
    for (const dir of tree.directories) mkdirSync(join(destination, dir), { mode: 0o700 });
    for (const [index, file] of inventory.files.entries()) {
      transformFile(
        join(source, file),
        join(destination, file),
        file,
        key,
        true,
        manifest.snapshot
      );
      // Preserve owner execution only, after this file authenticates; all other access stays private.
      if (
        'executable' in manifest &&
        typeof manifest.executable === 'string' &&
        manifest.executable[index] === '1'
      )
        chmodSync(join(destination, file), 0o700);
    }
  } catch {
    if (created) rmSync(destination, { recursive: true, force: true });
    throw new Error('Backup authentication failed; incomplete plaintext removed');
  } finally {
    key.fill(0);
  }
}
