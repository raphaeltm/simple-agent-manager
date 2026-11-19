/** Generate a disposable, synthetic-only fresh-session acceptance fixture.
 * No network, credentials, or runtime configuration are changed by this script.
 * Usage: node scripts/e2e/secret-exec-smoke.mjs --prepare=/tmp/secret-exec-fixture
 *        node scripts/e2e/secret-exec-smoke.mjs --verify=/tmp/secret-exec-report.json
 * Provision the generated env-vars.json ONLY on a disposable smoke project.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const selectedName = 'SECRET_EXEC_SMOKE_SELECTED';
const otherName = 'SECRET_EXEC_SMOKE_OTHER';
const placeholder = (name) => `__SAM_SECRET_REQUIRES_EXEC_WITH_SECRETS__${name}__`;
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const prepare = process.argv.find((arg) => arg.startsWith('--prepare='))?.slice(10);
const verify = process.argv.find((arg) => arg.startsWith('--verify='))?.slice(9);
assert(Boolean(prepare) !== Boolean(verify), 'Choose exactly one --prepare=DIR or --verify=REPORT');

if (prepare) {
  const directory = resolve(prepare);
  await mkdir(directory, { recursive: true });
  const marker = `secret-exec-smoke-${randomUUID()}`;
  const selectedValue = `synthetic-only-selected-${randomUUID()}`;
  const otherValue = `synthetic-only-other-${randomUUID()}`;
  const probe = `import hashlib, json, os, pathlib, socket, sys
MODE = sys.argv[1]
SELECTED = ${JSON.stringify(selectedName)}
OTHER = ${JSON.stringify(otherName)}
EXPECTED_HASH = ${JSON.stringify(sha256(selectedValue))}
MARKER = ${JSON.stringify(marker)}
def placeholder(name):
    return '__SAM_SECRET_REQUIRES_EXEC_WITH_SECRETS__' + name + '__'
def emit(checks):
    print(json.dumps({'marker': MARKER, 'mode': MODE, 'checks': checks}, sort_keys=True))
    if not all(checks.values()):
        sys.exit(1)
identity = {'uid': os.getuid(), 'gid': os.getgid(), 'cwd': os.getcwd(), 'hostname': socket.gethostname()}
if MODE == 'baseline':
    pathlib.Path('live-uncommitted.txt').write_text(MARKER)
    pathlib.Path('baseline.json').write_text(json.dumps(identity))
    emit({'defaultSelectedPlaceholder': os.environ.get(SELECTED) == placeholder(SELECTED),
          'defaultOtherPlaceholder': os.environ.get(OTHER) == placeholder(OTHER)})
elif MODE == 'injected':
    baseline = json.loads(pathlib.Path('baseline.json').read_text())
    emit({'selectedInjected': hashlib.sha256(os.environ.get(SELECTED, '').encode()).hexdigest() == EXPECTED_HASH,
          'otherPlaceholder': os.environ.get(OTHER) == placeholder(OTHER),
          'sameUid': identity['uid'] == baseline['uid'], 'sameGid': identity['gid'] == baseline['gid'],
          'explicitCwd': identity['cwd'] == baseline['cwd'], 'sameContainer': identity['hostname'] == baseline['hostname'],
          'liveUncommittedFile': pathlib.Path('live-uncommitted.txt').read_text() == MARKER,
          'explicitNonsecretEnv': os.environ.get('SECRET_EXEC_SMOKE_CONTEXT') == MARKER})
elif MODE == 'after':
    emit({'defaultSelectedStillPlaceholder': os.environ.get(SELECTED) == placeholder(SELECTED),
          'defaultOtherStillPlaceholder': os.environ.get(OTHER) == placeholder(OTHER)})
elif MODE == 'redaction':
    # Intentional echo of ONLY this fixture's selected synthetic sentinel.
    # Never use a real project credential for this mode.
    value = os.environ.get(SELECTED, '')
    assert hashlib.sha256(value.encode()).hexdigest() == EXPECTED_HASH
    print(value)
    print(value, file=sys.stderr)
else:
    raise SystemExit('Unsupported probe mode')
`;
  const prompt = `Run an authorized, synthetic-only exec_with_secrets acceptance test in this NEW disposable VM workspace. Read SAM instructions first. Do not deploy, create credentials, change policy/permissions, commit, or inspect unrelated environment values. All protected values in this fixture are throwaway test sentinels. Do not print, encode, or persist them except the explicitly requested synthetic redaction probe.

Read the exec_with_secrets tool description and report any contract difference rather than guessing. Use the existing container, current user, and live filesystem. Create a directory named ${marker} inside the current workspace, save the Python probe below as probe.py, and run its baseline mode using your ordinary shell tool in that directory. Record the absolute cwd and UID/GID, without dumping the environment. Do not change these defaults to make a failed check pass.

Call exec_with_secrets with argv ["python3", "probe.py", "injected"], secretNames ["${selectedName}"], cwd equal to the absolute probe directory, and env {"SECRET_EXEC_SMOKE_CONTEXT":"${marker}"}. Wait through the status tool if asynchronous. The probe must exit zero with all checks true. Then run the after mode through your ordinary shell tool. The uncommitted live file must be visible to both, and defaults must still be placeholders.

Run a second exec_with_secrets job with argv ["python3","probe.py","redaction"] and the same selected name/cwd. This deliberately emits ONLY the disposable sentinel to stdout and stderr. Verify both streams are redacted; do not recover or reproduce their original values. Run an explicit shell invocation (command "test -f live-uncommitted.txt", shell "sh", same cwd) to verify shell semantics. Run a timeout job (argv ["python3","-c","import time; time.sleep(30)"], timeoutMs 1000) and verify it reports timed_out. Use only limits accepted by the tool. Do not background any persistent process.

Preserve the probe and its non-secret baseline/results for independent verification. Report the actual job IDs and effective execution metadata. Finish with one JSON object between SECRET_EXEC_REPORT_BEGIN and SECRET_EXEC_REPORT_END:
{"marker":"${marker}","checks":{"defaultSelectedPlaceholder":true,"defaultOtherPlaceholder":true,"selectedInjected":true,"otherPlaceholder":true,"sameUid":true,"sameGid":true,"explicitCwd":true,"sameContainer":true,"liveUncommittedFile":true,"explicitNonsecretEnv":true,"defaultSelectedStillPlaceholder":true,"defaultOtherStillPlaceholder":true,"stdoutRedacted":true,"stderrRedacted":true,"explicitShell":true,"timeout":true},"jobIds":["actual IDs"],"cwd":"actual cwd","uid":0,"gid":0}
Use measured booleans and identities, never copy example success values. If anything fails, report false and the concrete error. Do not stop/restart other sessions or delete the fixture yourself.

Python probe (save verbatim):
${probe}`;
  await Promise.all([
    writeFile(
      `${directory}/env-vars.json`,
      JSON.stringify(
        [
          { key: selectedName, value: selectedValue, isSecret: true },
          { key: otherName, value: otherValue, isSecret: true },
        ],
        null,
        2
      ),
      { flag: 'wx', mode: 0o600 }
    ),
    writeFile(`${directory}/prompt.txt`, prompt, { flag: 'wx' }),
    writeFile(`${directory}/probe.py`, probe, { flag: 'wx' }),
    writeFile(
      `${directory}/manifest.json`,
      JSON.stringify(
        {
          marker,
          selectedName,
          otherName,
          selectedHash: sha256(selectedValue),
          otherHash: sha256(otherValue),
          placeholders: [placeholder(selectedName), placeholder(otherName)],
        },
        null,
        2
      ),
      { flag: 'wx' }
    ),
  ]);
  console.log(
    JSON.stringify({ directory, marker, syntheticOnly: true, names: [selectedName, otherName] })
  );
} else {
  const report = JSON.parse(await readFile(resolve(verify), 'utf8'));
  assert(/^secret-exec-smoke-[a-f0-9-]{36}$/.test(report.marker), 'Missing fixture marker');
  const checks = [
    'defaultSelectedPlaceholder',
    'defaultOtherPlaceholder',
    'selectedInjected',
    'otherPlaceholder',
    'sameUid',
    'sameGid',
    'explicitCwd',
    'sameContainer',
    'liveUncommittedFile',
    'explicitNonsecretEnv',
    'defaultSelectedStillPlaceholder',
    'defaultOtherStillPlaceholder',
    'stdoutRedacted',
    'stderrRedacted',
    'explicitShell',
    'timeout',
  ];
  for (const name of checks)
    assert.equal(report.checks?.[name], true, `Failed or missing check: ${name}`);
  assert(
    Array.isArray(report.jobIds) &&
      report.jobIds.length >= 4 &&
      report.jobIds.every((id) => typeof id === 'string' && id.length > 0),
    'Missing actual job IDs'
  );
  assert(typeof report.cwd === 'string' && report.cwd.startsWith('/'), 'Missing absolute cwd');
  assert(Number.isInteger(report.uid) && Number.isInteger(report.gid), 'Missing measured identity');
  console.log(
    JSON.stringify({
      marker: report.marker,
      checksPassed: checks.length,
      jobIds: report.jobIds,
      limitation:
        'Validate job/tool records independently; this validates the report, not its provenance.',
    })
  );
}
