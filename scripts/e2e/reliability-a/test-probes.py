#!/usr/bin/env python3
"""Local canary tests of actual CLI assets; not live SAM evidence."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
CANARY = 'ghs_SYNTHETIC_ONLY_CANARY_NOT_A_REAL_CREDENTIAL'


def scalar_output(test, result):
    test.assertNotIn(CANARY, result.stdout + result.stderr)
    value = json.loads(result.stdout)
    test.assertEqual(set(value), {'checks', 'statuses'})
    test.assertTrue(all(type(x) is bool for x in value['checks'].values()))
    test.assertTrue(all(type(x) is int for x in value['statuses'].values()))
    return value


class ActualProbeCanaryTests(unittest.TestCase):
    def test_malformed_arguments_are_sanitized(self):
        for script, args in [('b-probe.py', ['--timeout-seconds', CANARY]),
                             ('b-probe.py', ['--unknown', CANARY]),
                             ('git-probe.py', [CANARY]),
                             ('git-probe.py', ['check', '--unknown', CANARY])]:
            with self.subTest(script=script, args=args):
                result = subprocess.run(['python3', str(ROOT / script), *args], capture_output=True, text=True)
                scalar_output(self, result)
                self.assertEqual(result.returncode, 1)

    def test_a_timeout_kills_descendants(self):
        with tempfile.TemporaryDirectory(prefix='sam-timeout-canary-') as tmp:
            directory = Path(tmp)
            wrapper = directory / 'git'
            marker = directory / 'survived'
            wrapper.write_text('#!/usr/bin/env python3\nimport os,subprocess,sys,time\nsubprocess.Popen([sys.executable,"-c","import time,pathlib;time.sleep(0.5);pathlib.Path('+repr(str(marker))+').touch()"] )\nprint(os.environ["PROBE_CANARY"],flush=True)\ntime.sleep(5)\n')
            wrapper.chmod(0o700)
            env = {**os.environ, 'PATH': str(directory)+os.pathsep+os.environ['PATH'],
                   'PROBE_CANARY': CANARY, 'SAM_PROBE_GIT_TIMEOUT_SECONDS': '0.1'}
            result = subprocess.run(['python3', str(ROOT / 'git-probe.py'), 'check'], env=env, capture_output=True, text=True, timeout=3)
            scalar_output(self, result)
            import time
            time.sleep(0.7)
            self.assertFalse(marker.exists())

    def test_b_captures_helper_and_command_streams_on_success_failure_and_timeout(self):
        for mode in ['normal', 'failure', 'timeout']:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory(prefix='sam-probe-canary-') as tmp:
                directory = Path(tmp)
                helper = directory / 'helper'
                helper.write_text('''#!/usr/bin/env python3
# curl -fsS --max-time 30
import os,sys,time
value=os.environ['PROBE_CANARY']
sys.stdout.write('password='+value+'\\n')
sys.stderr.write(value+'\\n')
if os.environ['PROBE_FAKE_MODE']=='timeout':time.sleep(1)
sys.exit(42 if os.environ['PROBE_FAKE_MODE']=='failure' else 0)
''')
                helper.chmod(0o700)
                fake = '''#!/usr/bin/env python3
import os,sys,json,time
sys.stderr.write(os.environ['PROBE_CANARY']+'\\n')
mode=os.environ['PROBE_FAKE_MODE']
if mode=='timeout':time.sleep(1)
if mode=='failure':
 sys.stdout.write(os.environ['PROBE_CANARY']);sys.exit(42)
if sys.argv[0].endswith('/gh'):print(json.dumps({'isPrivate':True}));sys.exit(0)
key=sys.argv[-1]
if key=='credential.helper':print(os.environ['PROBE_FAKE_HELPER'])
elif key=='credential.useHttpPath':print('true')
elif key.startswith('http.'):sys.exit(1)
else:print('a'*40+'\\trefs/heads/'+os.environ['PROBE_CANARY'])
'''
                for name in ['git', 'gh']:
                    path = directory / name
                    path.write_text(fake)
                    path.chmod(0o700)
                env = {**os.environ, 'PATH': str(directory) + os.pathsep + os.environ['PATH'],
                       'PROBE_CANARY': CANARY, 'PROBE_FAKE_MODE': mode, 'PROBE_FAKE_HELPER': str(helper)}
                result = subprocess.run(['python3', str(ROOT / 'b-probe.py'), '--inspect-only',
                                         '--repository', 'owner/disposable', '--helper-path', str(helper),
                                         '--timeout-seconds', '0.05' if mode == 'timeout' else '2'],
                                        cwd=directory, env=env, capture_output=True, text=True, timeout=15)
                output = scalar_output(self, result)
                self.assertEqual(result.returncode, 1)  # Canary foreign-host output must fail closed.
                if mode == 'normal':
                    self.assertTrue(output['checks']['missingPathReturnedCredential'])
                    self.assertFalse(output['checks']['foreignHostDenied'])
                else:
                    self.assertIn(124 if mode == 'timeout' else 42, output['statuses'].values())

    def test_b_publication_streams_and_failed_inspection_gate(self):
        for denied in [True, False]:
            with self.subTest(denied=denied), tempfile.TemporaryDirectory(prefix='sam-publication-canary-') as tmp:
                directory = Path(tmp)
                helper = directory / 'helper'
                helper.write_text('#!/bin/sh\ncurl() { :; }\ncurl --max-time 30 \nrequest=$(cat)\ncase "$request" in *example.invalid*) exit 0;; esac\nprintf "password=%s\\n" "$PROBE_CANARY"\nprintf "%s\\n" "$PROBE_CANARY" >&2\n')
                helper.chmod(0o700)
                fake = directory / 'git'
                fake.write_text('''#!/usr/bin/env python3
import os,sys,pathlib
args=sys.argv[1:]
print(os.environ['PROBE_CANARY'],file=sys.stderr)
if args[:2]==['config','--get']:
 key=args[-1]
 if key=='credential.helper':print(os.environ['PROBE_FAKE_HELPER'])
 elif key=='credential.useHttpPath':print('true')
 else:sys.exit(1)
elif args[0]=='ls-remote':print('a'*40+'\\trefs/heads/test')
elif args[0]=='clone':
 pathlib.Path(os.environ['PROBE_CLONE_MARKER']).touch()
 pathlib.Path(args[-1]).mkdir()
 print(os.environ['PROBE_CANARY'])
elif args[0]=='rev-parse':print('a'*40)
else:print(os.environ['PROBE_CANARY'])
''')
                fake.chmod(0o700)
                gh = directory / 'gh'
                gh.write_text('#!/usr/bin/env python3\nimport os,sys,json\nprint(os.environ["PROBE_CANARY"],file=sys.stderr)\nprint(json.dumps(dict(isPrivate=os.environ["PROBE_PRIVATE"]=="true")))\n')
                gh.chmod(0o700)
                marker = directory / 'clone-called'
                env = {**os.environ, 'PATH': str(directory)+os.pathsep+os.environ['PATH'],
                       'PROBE_CANARY': CANARY, 'PROBE_FAKE_HELPER': str(helper),
                       'PROBE_PRIVATE': 'true' if denied else 'false', 'PROBE_CLONE_MARKER': str(marker)}
                result = subprocess.run(['python3', str(ROOT / 'b-probe.py'), '--disposable-repository',
                                         '--repository', 'owner/disposable', '--branch', 'sam/reliability-b-canary',
                                         '--helper-path', str(helper)], cwd=directory, env=env,
                                        capture_output=True, text=True, timeout=10)
                output = scalar_output(self, result)
                self.assertEqual(marker.exists(), denied)
                if denied:
                    self.assertTrue(output['checks']['explicitPush'])
                    self.assertEqual(result.returncode, 0)
                else:
                    self.assertEqual(result.returncode, 1)

    def test_a_captures_git_stderr_and_detects_worktree_tampering(self):
        with tempfile.TemporaryDirectory(prefix='sam-a-canary-') as tmp:
            directory = Path(tmp)
            remote, repo, tools = directory / 'remote.git', directory / 'repo', directory / 'tools'
            tools.mkdir()
            def git(*args, cwd=None):
                subprocess.run(['/usr/bin/git', *args], cwd=cwd, check=True, capture_output=True)
            git('init', '--bare', '--initial-branch=main', str(remote))
            git('clone', str(remote), str(repo))
            git('config', 'user.name', 'Local synthetic probe', cwd=repo)
            git('config', 'user.email', 'probe@example.invalid', cwd=repo)
            (repo / 'initial.txt').write_text('initial')
            git('add', 'initial.txt', cwd=repo)
            git('commit', '-m', 'initial', cwd=repo)
            git('push', '-u', 'origin', 'main', cwd=repo)
            git('switch', '-c', 'sam/local-probe', cwd=repo)
            wrapper = tools / 'git'
            wrapper.write_text('#!/usr/bin/env python3\nimport os,sys\nsys.stderr.write(os.environ["PROBE_CANARY"]+"\\n")\nos.execv("/usr/bin/git",["git",*sys.argv[1:]])\n')
            wrapper.chmod(0o700)
            env = {**os.environ, 'PATH': str(tools) + os.pathsep + os.environ['PATH'], 'PROBE_CANARY': CANARY}
            def probe(*args):
                return subprocess.run(['python3', str(ROOT / 'git-probe.py'), *args], cwd=repo,
                                      env=env, capture_output=True, text=True, timeout=15)
            (repo / 'user-staged.txt').write_text('preserve staged user work')
            git('add', 'user-staged.txt', cwd=repo)
            result = probe('prepare', '--disposable-repository')
            scalar_output(self, result)
            self.assertEqual(result.returncode, 0)
            staged = subprocess.run(['/usr/bin/git', 'show', ':user-staged.txt'], cwd=repo, capture_output=True, text=True, check=True)
            self.assertEqual(staged.stdout, 'preserve staged user work')
            committed = subprocess.run(['/usr/bin/git', 'ls-tree', '--name-only', 'HEAD', 'user-staged.txt'], cwd=repo, capture_output=True, text=True, check=True)
            self.assertEqual(committed.stdout, '')
            result = probe('check')
            output = scalar_output(self, result)
            self.assertTrue(all(output['checks'].values()))
            baseline = repo / '.reliability-a/baseline.json'
            original = baseline.read_text()
            malformed = ['{}', '{"head":"' + 'a'*40 + '"}', '{',
                         json.dumps({**json.loads(original), 'unexpected': True}),
                         json.dumps({**json.loads(original), 'files': {}}),
                         json.dumps({**json.loads(original), 'index': 1})]
            for invalid in malformed:
                baseline.write_text(invalid)
                result = probe('check')
                output = scalar_output(self, result)
                self.assertEqual(result.returncode, 1)
                self.assertFalse(output['checks']['probeCompleted'])
            baseline.unlink()  # Interrupted preparation cannot supply a usable baseline.
            result = probe('check')
            scalar_output(self, result)
            self.assertEqual(result.returncode, 1)
            baseline.write_text(original)
            (repo / 'index-change.txt').write_text('index change')
            git('add', 'index-change.txt', cwd=repo)
            result = probe('check')
            output = scalar_output(self, result)
            self.assertFalse(output['checks']['indexUnchanged'])
            git('reset', '--', 'index-change.txt', cwd=repo)
            (repo / 'index-change.txt').unlink()
            old_head = json.loads(original)['head']
            git('commit', '--allow-empty', '-m', 'head change', cwd=repo)
            result = probe('check')
            output = scalar_output(self, result)
            self.assertFalse(output['checks']['headUnchanged'])
            git('reset', '--soft', old_head, cwd=repo)
            git('update-ref', 'refs/heads/remote-change', 'HEAD', cwd=remote)
            result = probe('check')
            output = scalar_output(self, result)
            self.assertFalse(output['checks']['remoteRefsUnchanged'])
            git('update-ref', '-d', 'refs/heads/remote-change', cwd=remote)
            (repo / '.reliability-a/tracked.txt').write_text(CANARY)
            result = probe('check')
            output = scalar_output(self, result)
            self.assertEqual(result.returncode, 1)
            self.assertFalse(output['checks']['filesUnchanged'])
            wrapper.write_text('#!/usr/bin/env python3\nimport os,sys\nsys.stdout.write(os.environ["PROBE_CANARY"])\nsys.stderr.write(os.environ["PROBE_CANARY"])\nsys.exit(42)\n')
            result = probe('check')
            output = scalar_output(self, result)
            self.assertEqual(result.returncode, 1)
            self.assertFalse(output['checks']['probeCompleted'])


if __name__ == '__main__':
    unittest.main()
