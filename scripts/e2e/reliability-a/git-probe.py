#!/usr/bin/env python3
"""Disposable-repository live probe. Never invokes push or review creation."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import os
import signal


def git(*args):
    try:
        process = subprocess.Popen(['git', *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   start_new_session=True)
        try:
            output, _ = process.communicate(timeout=float(os.environ.get('SAM_PROBE_GIT_TIMEOUT_SECONDS', '60')))
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.communicate()
            raise RuntimeError('suppressed')
    except OSError:
        raise RuntimeError('suppressed')
    if process.returncode != 0:
        raise RuntimeError('suppressed')
    return output.decode().strip()


def state():
    paths = ['.reliability-a/tracked.txt', '.reliability-a/staged-new.txt',
             '.reliability-a/untracked.txt', '.do-state.md', '.workflow-state.md']
    return {
        'head': git('rev-parse', 'HEAD'),
        'branch': git('branch', '--show-current'),
        'index': git('write-tree'),
        'status': git('status', '--porcelain=v1', '--untracked-files=all'),
        'files': {name: hashlib.sha256(Path(name).read_bytes()).hexdigest() for name in paths},
        'stagedTracked': git('show', ':.reliability-a/tracked.txt'),
        'stagedNew': git('show', ':.reliability-a/staged-new.txt'),
        'remoteRefs': git('ls-remote', '--heads', 'origin'),
    }


class QuietParser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError('configuration')


def main():
    parser = QuietParser(description=__doc__)
    parser.add_argument('mode', choices=['prepare', 'check'])
    parser.add_argument('--disposable-repository', action='store_true')
    args = parser.parse_args()
    root = Path(git('rev-parse', '--show-toplevel')).resolve()
    if Path.cwd().resolve() != root:
        parser.error('Run from the supported workspace repository root')
    fixture = root / '.reliability-a'
    baseline = fixture / 'baseline.json'
    if args.mode == 'prepare':
        if not args.disposable_repository:
            parser.error('prepare requires --disposable-repository; it explicitly commits named test files')
        if fixture.exists():
            parser.error('Fixture already exists; do not overwrite or rerun preparation')
        remote_head = git('ls-remote', '--symref', 'origin', 'HEAD')
        default_refs = [line.split()[1].removeprefix('refs/heads/') for line in remote_head.splitlines() if line.startswith('ref: ')]
        if not default_refs:
            parser.error('Remote default branch is unknown; resolve repository setup before testing')
        if git('branch', '--show-current') in ['', 'main', 'master', *default_refs]:
            parser.error('Use a dedicated disposable task output branch, never the default branch')
        fixture.mkdir()
        tracked = fixture / 'tracked.txt'
        tracked.write_text('local committed baseline\n')
        git('add', '--', '.reliability-a/tracked.txt')
        # Only fixture path is committed; preserve any pre-existing staged user work.
        git('commit', '--only', '-m', 'test: explicit local preservation fixture', '--', '.reliability-a/tracked.txt')
        tracked.write_text('staged tracked content\n')
        (fixture / 'staged-new.txt').write_text('staged new content\n')
        git('add', '--', '.reliability-a/tracked.txt', '.reliability-a/staged-new.txt')
        tracked.write_text('staged tracked content plus unstaged edit\n')
        (fixture / 'untracked.txt').write_text('untracked preservation fixture\n')
        for name in ['.do-state.md', '.workflow-state.md']:
            if not Path(name).exists():
                Path(name).write_text('Local workflow preservation fixture; never publish.\n')
        baseline.write_text('{}\n')
        observed = state()
        # The deliberate local commit must not already exist on the remote.
        if observed['head'] in observed['remoteRefs']:
            raise RuntimeError('suppressed')
        baseline.write_text(json.dumps(observed, indent=2) + '\n')
        print(json.dumps({'checks': {'prepared': True, 'localCommitUnpublished': True}, 'statuses': {'probe': 0}}, sort_keys=True))
    else:
        expected = json.loads(baseline.read_text())
        observed = state()
        checks = {key + 'Unchanged': observed[key] == expected[key] for key in expected}
        print(json.dumps({'checks': checks, 'statuses': {'probe': 0 if all(checks.values()) else 1}}, sort_keys=True))
        if not all(checks.values()):
            raise SystemExit(1)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'checks': {'probeCompleted': False}, 'statuses': {'probe': 1}}))
        raise SystemExit(1)
