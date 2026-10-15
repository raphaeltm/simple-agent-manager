#!/usr/bin/env python3
"""Disposable live Git probe; subprocess streams stay private, output is booleans/statuses."""
import argparse
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile


class Probe:
    def __init__(self, config):
        self.config = config
        self.timeout = config.timeout_seconds
        self.statuses = {}
        self.checks = {}

    def run(self, label, argv, cwd=None, data=None):
        try:
            process = subprocess.Popen(argv, cwd=cwd, stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       start_new_session=True,
                                       env={**os.environ, 'GIT_TERMINAL_PROMPT': '0'})
            try:
                output, _ = process.communicate(input=data, timeout=self.timeout)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                try:
                    process.communicate(timeout=0.25)
                except subprocess.TimeoutExpired:
                    # Detached descendants may retain pipes: close without waiting for EOF.
                    for stream in [process.stdin, process.stdout, process.stderr]:
                        if stream is not None:
                            stream.close()
                    process.wait(timeout=0.25)
                self.statuses[label] = 124
                return 124, b''
            self.statuses[label] = process.returncode
            return process.returncode, output
        except OSError:
            self.statuses[label] = 127
            return 127, b''

    def inspect(self, helper):
        try:
            content = Path(helper).read_bytes()  # Never emit body/hash or embedded credentials.
            self.checks['helperTimeout30'] = bool(re.search(rb'(?m)^\s*curl\b[^\n]*--max-time\s+["\']?30(?:\s|["\'])', content))
        except OSError:
            self.checks['helperTimeout30'] = False
        for key in ['credential.helper', 'credential.useHttpPath', 'http.lowSpeedLimit', 'http.lowSpeedTime']:
            code, value = self.run(key, ['git', 'config', '--get', key])
            if key == 'credential.helper':
                self.checks['helperSimpleAbsolutePath'] = code == 0 and bool(re.fullmatch(rb'/[A-Za-z0-9_./-]+\s*', value))
            elif key == 'credential.useHttpPath':
                self.checks['useHttpPath'] = code == 0 and value.strip() == b'true'
            else:
                self.checks[key + 'UnsetOrNumeric'] = code == 1 or (code == 0 and value.strip().isdigit())
        for label, request in [
            ('missingPath', b'protocol=https\nhost=github.com\n\n'),
            ('foreignHost', b'protocol=https\nhost=example.invalid\npath=owner/repo\n\n'),
        ]:
            code, output = self.run(label, [helper, 'get'], data=request)
            if label == 'missingPath':
                # Measured behavior, not a claim this request must be denied.
                self.checks['missingPathReturnedCredential'] = code == 0 and bool(output.strip())
            else:
                self.checks['foreignHostDenied'] = code == 0 and not output.strip()
        code, output = self.run('privateGitAccess', ['git', 'ls-remote', '--heads', 'origin'])
        self.checks['privateGitAccess'] = code == 0 and valid_refs(output)
        code, output = self.run('privateGhAccess', ['gh', 'repo', 'view', self.config.repository, '--json', 'isPrivate'])
        try:
            self.checks['privateGhAccess'] = code == 0 and json.loads(output).get('isPrivate') is True
        except (ValueError, AttributeError):
            self.checks['privateGhAccess'] = False
        metadata = Path('/etc/sam/vm-agent-version.json')
        if metadata.exists():
            try:
                import hashlib
                info = json.loads(metadata.read_text())
                self.checks['installedReleaseMatches'] = info.get('version') == self.config.expected_release
                self.checks['installedBinaryMatches'] = hashlib.sha256(Path('/usr/local/bin/vm-agent').read_bytes()).hexdigest() == self.config.expected_binary_sha256
            except (OSError, ValueError):
                self.checks['installedReleaseMatches'] = False
                self.checks['installedBinaryMatches'] = False

    def publish_disposable(self, repository, branch):
        # This is explicit B prefixture publication; A baseline must not exist yet.
        self.checks['beforeABaseline'] = not Path('.reliability-a/baseline.json').exists()
        if not self.checks['beforeABaseline']:
            return
        with tempfile.TemporaryDirectory(prefix='sam-b-disposable-') as directory:
            clone = str(Path(directory) / 'clone')
            code, _ = self.run('clone', ['git', 'clone', '--depth', '1', '--filter=blob:none',
                                       'https://github.com/' + repository + '.git', clone])
            self.checks['privateClone'] = code == 0
            if code != 0:
                return
            for label, command in [
                ('name', ['git', 'config', 'user.name', 'SAM disposable probe']),
                ('email', ['git', 'config', 'user.email', 'probe@example.invalid']),
                ('branch', ['git', 'switch', '-c', branch]),
            ]:
                code, _ = self.run(label, command, cwd=clone)
                if code != 0:
                    self.checks['explicitPush'] = False
                    return
            before_code, before_tree = self.run('beforeTree', ['git', 'rev-parse', 'HEAD^{tree}'], cwd=clone)
            code, _ = self.run('commit', ['git', 'commit', '--allow-empty', '-m', 'test: explicit disposable B fixture'], cwd=clone)
            after_code, after_tree = self.run('afterTree', ['git', 'rev-parse', 'HEAD^{tree}'], cwd=clone)
            self.checks['testCommitTreeUnchanged'] = before_code == after_code == code == 0 and before_tree == after_tree
            if not self.checks['testCommitTreeUnchanged']:
                return
            code, _ = self.run('push', ['git', 'push', 'origin', 'HEAD:refs/heads/' + branch], cwd=clone)
            self.checks['explicitPush'] = code == 0


def valid_refs(output):
    return bool(output.strip()) and all(re.fullmatch(rb'[0-9a-f]{40,64}\trefs/heads/[^\s]+', line)
                                        for line in output.splitlines())


class QuietParser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError('configuration')


def main():
    parser = QuietParser(description=__doc__)
    parser.add_argument('--inspect-only', action='store_true')
    parser.add_argument('--disposable-repository', action='store_true')
    parser.add_argument('--repository', required=True)
    parser.add_argument('--branch')
    parser.add_argument('--helper-path', default='/usr/local/bin/git-credential-sam')
    parser.add_argument('--timeout-seconds', type=float, default=60)
    parser.add_argument('--expected-release', default='b467f389811eadeaf973960bb30f9fa7b9cb4678')
    parser.add_argument('--expected-binary-sha256', default='a59a4850337fe7af588267c481dee046db5baba4d3f705c85f19f85ded09e06f')
    args = parser.parse_args()
    import math
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', args.repository) or not math.isfinite(args.timeout_seconds) or args.timeout_seconds <= 0:
        parser.error('configuration')
    if not args.inspect_only and (not args.disposable_repository or not args.branch or
                                 not re.fullmatch(r'sam/reliability-b-[a-z0-9-]+', args.branch)):
        parser.error('configuration')
    probe = Probe(args)
    try:
        probe.inspect(args.helper_path)
        required = [value for key, value in probe.checks.items() if key != 'missingPathReturnedCredential']
        if not args.inspect_only and required and all(required):
            probe.publish_disposable(args.repository, args.branch)
    except Exception:
        probe.checks['probeCompleted'] = False
        probe.statuses['probe'] = 1
    else:
        probe.checks['probeCompleted'] = True
    print(json.dumps({'checks': probe.checks, 'statuses': probe.statuses}, sort_keys=True))
    required = [value for key, value in probe.checks.items() if key != 'missingPathReturnedCredential']
    return 0 if required and all(required) else 1


if __name__ == '__main__':
    try:
        result = main()
    except Exception:
        print(json.dumps({'checks': {'probeCompleted': False}, 'statuses': {'probe': 1}}))
        result = 1
    raise SystemExit(result)
