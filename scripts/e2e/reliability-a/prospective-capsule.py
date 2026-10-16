"""Fixed prospective fixture operations. Trusted host writes config, never the model.
All helper output stays private. Only typed artifacts are exported by the host.
"""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys

HASHES = {'git-probe.py': 'f061b7cd447cef55ceb08cb6a78fcb0b236ec3f347731e66d4b8447c224afa6c',
          'b-probe.py': '889d7588ed44c8ab89e6ba7880ff20d81017f294bb7b31edfbc320ced064f509',
          'terminal-observer.py': 'd0970080ce89ab2810c0c9d758d1fc978efafe75fed91a4454f08639da88adff'}


def checked_bytes(path, limit=131072):
    if path.is_symlink() or not path.is_file():
        raise ValueError()
    with path.open('rb') as stream:
        value = stream.read(limit + 1)
    if len(value) > limit:
        raise ValueError()
    return value


def save(path, data):
    # Exclusive immutable artifacts: a repeated phase must fail, never rebaseline.
    with path.open('xb') as stream:
        stream.write(data)
    path.chmod(0o600)


def run(argv, cwd, timeout=12):
    child = subprocess.Popen(argv, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             start_new_session=True, env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1',
                             'SAM_PROBE_GIT_TIMEOUT_SECONDS': '5'})
    try:
        out, _ = child.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        try:
            child.communicate(timeout=1)
        except subprocess.TimeoutExpired:
            child.stdout.close()
            child.stderr.close()
            child.wait(timeout=1)
        raise ValueError()
    if child.returncode != 0 or len(out) > 131072:
        raise ValueError()
    return out


def phase(config, directory):
    if set(config) != {'taskId', 'sessionId', 'branch', 'runId', 'operation', 'assets', 'baseline', 'expectations', 'completedAt'}:
        raise ValueError()
    if not re.fullmatch('[0-9A-HJKMNP-TV-Z]{26}', config['taskId']) or not re.fullmatch('[0-9a-f-]{36}', config['sessionId']):
        raise ValueError()
    if not re.fullmatch('sam/[a-z0-9][a-z0-9/-]{0,150}', config['branch']) or not re.fullmatch('[0-9a-f-]{36}', config['runId']):
        raise ValueError()
    mode = config['operation']
    if mode not in ['setup', 'check', 'observe'] or set(config['assets']) != set(HASHES):
        raise ValueError()
    root = Path.cwd().resolve()
    if run(['git', 'rev-parse', '--show-toplevel'], root).decode().strip() != str(root):
        raise ValueError()
    # Observer runs elsewhere and checks the target branch only through the original observer.
    if mode != 'observe' and run(['git', 'branch', '--show-current'], root).decode().strip() != config['branch']:
        raise ValueError()
    assets = directory / 'assets'
    assets.mkdir(mode=0o700)
    for name, digest in HASHES.items():
        data = base64.b64decode(config['assets'][name], validate=True)
        if len(data) > 100000 or hashlib.sha256(data).hexdigest() != digest:
            raise ValueError()
        save(assets / name, data)
    baseline = directory / 'baseline.json'
    expectations = directory / 'expectations.json'
    python = sys.executable
    if not Path(python).is_absolute():
        raise ValueError()
    probe = [python, str(assets / 'git-probe.py')]
    observer = [python, str(assets / 'terminal-observer.py')]
    exported = []
    if mode != 'observe':
        release = json.loads(checked_bytes(Path('/etc/sam/vm-agent-version.json')))
        binary = Path('/usr/local/bin/vm-agent')
        digest = hashlib.sha256()
        with binary.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1048576), b''):
                digest.update(chunk)
        runtime = {'checks': {'installedReleaseMatches': release.get('version') == 'b467f389811eadeaf973960bb30f9fa7b9cb4678',
                              'installedBinaryMatches': digest.hexdigest() == 'a59a4850337fe7af588267c481dee046db5baba4d3f705c85f19f85ded09e06f'}, 'statuses': {'proof': 0}}
        save(directory / 'runtime.json', json.dumps(runtime).encode())
        if not all(runtime['checks'].values()):
            raise ValueError()
        exported.append('runtime.json')
    if mode == 'setup':
        if config['baseline'] is not None or config['expectations'] is not None or config['completedAt'] is not None:
            raise ValueError()
        if (root / '.reliability-a').exists() or (root / '.reliability-a').is_symlink():
            raise ValueError()
        save(directory / 'prepare.json', run(probe + ['prepare', '--disposable-repository'], root, 30))
        save(baseline, checked_bytes(root / '.reliability-a/baseline.json'))
        exported.extend(['prepare.json', 'baseline.json'])
    else:
        save(baseline, base64.b64decode(config['baseline'], validate=True))
        save(expectations, base64.b64decode(config['expectations'], validate=True))
        if mode == 'check' and checked_bytes(root / '.reliability-a/baseline.json') != checked_bytes(baseline):
            raise ValueError()
    if mode != 'observe':
        save(directory / 'check.json', run(probe + ['check'], root, 25))
        exported.append('check.json')
    argv = observer + ['record' if mode == 'setup' else 'check', '--repository', 'serverspresentation2025/crewai',
                      '--branch', config['branch'], '--baseline', str(baseline), '--expectations', str(expectations),
                      '--timeout-seconds', '5']
    if mode == 'setup':
        save(directory / 'record.json', run(argv, root, 20))
        expectations.chmod(0o600)
        exported.extend(['record.json', 'expectations.json'])
    elif mode == 'observe':
        argv += ['--terminal-completed-at', config['completedAt']]
        save(directory / 'observer.json', run(argv, root, 20))
        exported.append('observer.json')
    if mode == 'check':
        spec = importlib.util.spec_from_file_location('fixed_observer', assets / 'terminal-observer.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        expected = json.loads(checked_bytes(expectations))
        base = json.loads(checked_bytes(baseline))
        module.A.validate(base)
        if expected['branch'] != config['branch'] or expected['remoteRefs'] != module.refs(base['remoteRefs']):
            raise ValueError()
        from types import SimpleNamespace
        helper = module.B.Probe(SimpleNamespace(timeout_seconds=5))
        code, refs = helper.run('remoteRefs', ['git', 'ls-remote', '--heads', 'https://github.com/serverspresentation2025/crewai.git'])
        if code != 0:
            raise ValueError()
        code, prs = helper.run('prInventory', ['gh', 'pr', 'list', '--repo', 'serverspresentation2025/crewai', '--head', config['branch'], '--state', 'all', '--limit', str(expected['prLimit']), '--json', 'number,url,state,headRefName'])
        if code != 0:
            raise ValueError()
        checks = {'remoteRefsUnchanged': module.refs(refs.decode()) == expected['remoteRefs'],
                  'taskBranchPrInventoryUnchanged': module.inventory(json.loads(prs), 'serverspresentation2025/crewai', config['branch'], expected['prLimit']) == expected['prs']}
        save(directory / 'publication.json', json.dumps({'checks': checks, 'statuses': helper.statuses}).encode())
        if not all(checks.values()):
            raise ValueError()
        exported.append('publication.json')
    return exported


def main():
    # One task/run-specific transfer directory; host hash verifies script/config before execution.
    directory = Path(sys.argv[1]).resolve()
    config = json.loads(checked_bytes(directory / 'config.json', 400000))
    original_cwd = Path.cwd()
    files = []
    status = 1
    try:
        files = phase(config, directory)
        status = 0
    except Exception:
        pass
    finally:
        os.chdir(original_cwd)
    manifest = {'taskId': config['taskId'], 'sessionId': config['sessionId'], 'runId': config['runId'],
                'operation': config['operation'], 'status': status,
                'files': {name: hashlib.sha256(checked_bytes(directory / name)).hexdigest() for name in files}}
    save(directory / 'done.json', json.dumps(manifest, separators=(',', ':')).encode())
    return status


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception:
        raise SystemExit(1)
