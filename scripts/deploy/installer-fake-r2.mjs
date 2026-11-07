// Test-only stand-in for curl against R2: serves a directory as the bucket and records
// each credential file it was handed, so tests can prove credentials were present
// during a request and gone afterwards.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FAKE_CURL = `#!/usr/bin/env bash
set -euo pipefail
method=GET
while (($#)); do
  case "$1" in
    --config) cat "$2" >> "$FAKE_R2_LOG"; shift ;;
    --output) out=$2; shift ;;
    --upload-file) upload=$2; shift ;;
    --request) method=$2; shift ;;
    --max-filesize|--proto|--max-time|--aws-sigv4|--write-out) shift ;;
    https://*) url=$1 ;;
  esac
  shift
done
object="$FAKE_R2_ROOT/\${url#https://*/}"
if [[ $method == PUT ]]; then
  mkdir -p "$(dirname "$object")"; cp "$upload" "$object"; : > "$out"; printf 200
elif [[ -f $object ]]; then cp "$object" "$out"; printf 200
else printf '<Error>NoSuchKey</Error>' > "$out"; printf 404
fi
`;

export function filesUnder(path) {
  if (!existsSync(path)) return [];
  return readdirSync(path, { recursive: true })
    .map((name) => join(path, String(name)))
    .filter((file) => statSync(file).isFile());
}

/** Run `action` with a fake `curl` first on PATH; restores the environment after. */
export async function withFakeR2(action) {
  const root = mkdtempSync(join(tmpdir(), 'sam-fake-r2-'));
  const saved = process.env.PATH;
  try {
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'bin', 'curl'), FAKE_CURL);
    chmodSync(join(root, 'bin', 'curl'), 0o755);
    process.env.PATH = `${join(root, 'bin')}:${saved}`;
    process.env.FAKE_R2_ROOT = join(root, 'bucket');
    process.env.FAKE_R2_LOG = join(root, 'credentials.log');
    return await action({ root, log: process.env.FAKE_R2_LOG });
  } finally {
    process.env.PATH = saved;
    delete process.env.FAKE_R2_ROOT;
    delete process.env.FAKE_R2_LOG;
    rmSync(root, { recursive: true, force: true });
  }
}
