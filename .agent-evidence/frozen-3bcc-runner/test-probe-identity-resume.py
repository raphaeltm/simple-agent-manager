"""Focused actual CLI regression for the one failed, disposable FIRST fixture."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

PROBE = Path(__file__).with_name('git-probe.py')
BRANCH = 'sam/bootstrap-only-authorized-reliability-w6frxd'


class IdentityResumeTest(unittest.TestCase):
    def test_command_local_identity_and_exact_partial_resume_refuse_ambiguity(self):
        env = dict(os.environ, GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_COUNT='0')
        for key in ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']:
            env.pop(key, None)
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            for mode in ['fresh', 'resume', 'extra-file', 'content', 'staged-content', 'foreign-staged', 'new-head', 'baseline', 'workflow', 'wrong-branch']:
                with self.subTest(mode=mode):
                    folder = base / mode
                    folder.mkdir()
                    remote, repo = folder / 'remote.git', folder / 'repo'
                    repo.mkdir()
                    def run(*args, ok=True):
                        r = subprocess.run(['git', *args], cwd=repo, env=env, capture_output=True, timeout=10)
                        if ok:
                            self.assertEqual(r.returncode, 0)
                        return r
                    run('init', '--bare', '--initial-branch=main', str(remote))
                    run('init', '--initial-branch=main')
                    run('-c', 'user.name=Setup', '-c', 'user.email=setup@example.invalid', 'commit', '--allow-empty', '-m', 'base')
                    run('remote', 'add', 'origin', str(remote))
                    run('switch', '-c', BRANCH)
                    run('push', 'origin', 'main', BRANCH)
                    if mode != 'fresh':
                        fixture = repo / '.reliability-a'
                        fixture.mkdir()
                        (fixture / 'tracked.txt').write_bytes(b'local committed baseline\n')
                        run('add', '--', '.reliability-a/tracked.txt')
                        self.assertNotEqual(run('commit', '--only', '-m', 'expected identity failure', '--', '.reliability-a/tracked.txt', ok=False).returncode, 0)
                        if mode == 'extra-file':
                            (fixture / 'untracked.txt').write_text('ambiguous')
                        elif mode == 'content':
                            (fixture / 'tracked.txt').write_text('ambiguous')
                        elif mode == 'staged-content':
                            (fixture / 'tracked.txt').write_text('ambiguous')
                            run('add', '--', '.reliability-a/tracked.txt')
                        elif mode == 'foreign-staged':
                            (repo / 'foreign.txt').write_text('ambiguous')
                            run('add', '--', 'foreign.txt')
                        elif mode == 'new-head':
                            run('-c', 'user.name=Setup', '-c', 'user.email=setup@example.invalid', 'commit', '--allow-empty', '--only', '-m', 'unexpected local head')
                        elif mode == 'baseline':
                            (fixture / 'baseline.json').write_text('{}')
                        elif mode == 'workflow':
                            (repo / '.workflow-state.md').write_text('ambiguous')
                        elif mode == 'wrong-branch':
                            run('switch', '-c', 'sam/foreign')
                    def retained_state():
                        files = {str(p.relative_to(repo)): hashlib.sha256(p.read_bytes()).hexdigest()
                                 for p in repo.rglob('*') if p.is_file() and '.git' not in p.relative_to(repo).parts}
                        return (run('rev-parse', 'HEAD').stdout, run('status', '--porcelain=v1', '--untracked-files=all').stdout,
                                run('ls-files', '--stage').stdout, files, run('ls-remote', '--heads', 'origin').stdout)
                    before = retained_state()
                    result = subprocess.run(['python3', str(PROBE), 'prepare' if mode == 'fresh' else 'resume-incomplete', '--disposable-repository'], cwd=repo, env=env, capture_output=True, text=True, timeout=20)
                    value = json.loads(result.stdout)
                    self.assertEqual(result.stderr, '')
                    if mode in ['fresh', 'resume']:
                        self.assertEqual(result.returncode, 0)
                        self.assertEqual(value, {'checks': {'prepared': True, 'localCommitUnpublished': True}, 'statuses': {'probe': 0}})
                        self.assertTrue((repo / '.reliability-a/baseline.json').is_file())
                        self.assertEqual(run('log', '-1', '--format=%an|%ae').stdout.strip(), b'Reliability Verification|reliability-verification@example.invalid')
                        self.assertEqual(before[-1], retained_state()[-1], 'no remote publication')
                    else:
                        self.assertEqual(result.returncode, 1)
                        self.assertEqual(value, {'checks': {'probeCompleted': False}, 'statuses': {'probe': 1}})
                        self.assertEqual(retained_state(), before, 'ambiguous partial must remain byte/index/HEAD/ref unchanged')
                    self.assertEqual(run('config', '--get', 'user.name', ok=False).returncode, 1)
                    self.assertEqual(run('config', '--get', 'user.email', ok=False).returncode, 1)


if __name__ == '__main__':
    unittest.main()
