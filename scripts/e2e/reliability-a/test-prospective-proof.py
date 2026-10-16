"""Actual fixed CF reader CLI with simulated HTTP/settings/D1 boundaries; no live calls."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import re
import subprocess
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('prospective_proof', ROOT / 'prospective-proof.py')
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)
PIN = {'apiSource': 'c'*40, 'agentSource': 'd'*40, 'publishedBinarySha256': 'e'*64, 'rawHostShaObserved': False, 'capacityPoolRevision': 73}
CANARY = 'PRIVATE_SYNTHETIC_CF_CANARY'


class ReaderTests(unittest.TestCase):
    def invoke(self, mode, failure=None):
        with tempfile.TemporaryDirectory(prefix='sam-proof-reader-') as folder:
            root = Path(folder)
            now = int(time.time() * 1000)
            own = {'taskId': '01M51ZZZZZZZZZZZZZZZZZZZZZ', 'sessionId': '11111111-2222-4333-8444-555555555555', 'branch': 'sam/prospective-claude', 'agentProfileId': '01KRS7Z2R88JFC73ARA7DV9WTK', 'agentType': 'claude-code'}
            if mode == 'resume-snapshot' and failure != 'resume-foreign-task': own.update(taskId='01M51Q2J7AQEKAKZAKZ39NFXWP',sessionId='f5f56c5b-e9fb-4218-b327-bd9d4b7e25e9',branch='sam/authorized-one-clean-prospective-9nfxwp')
            own['receipt'] = {'taskId': own['taskId'], 'sessionId': own['sessionId'], 'branchName': own['branch'], 'status': 'queued'}
            observer = {**own, 'agentType': 'openai-codex'}
            config = {'own': own, 'observer': observer, 'started': now - 10000, 'hard': now + 2700000}
            if mode == 'resume-snapshot': config['resume']={'kind':'second-prospective-restore','originalEvidenceSha256':'9715d238b6fcf5cc1e45e065ea041e87e8b72b38b6776664827467a6e74c14d2'}
            (root / 'config.json').write_text(json.dumps(config))
            (root / 'release-pin.json').write_text(json.dumps(PIN))
            if failure == 'missing-pin': (root / 'release-pin.json').unlink()
            if failure == 'malformed-pin': (root / 'release-pin.json').write_text('{}')
            workspace, node, snapshot = '01M51YYYYYYYYYYYYYYYYYYYYY', '01M51XXXXXXXXXXXXXXXXXXXXX', '01M51SSSSSSSSSSSSSSSSSSSSS'
            for name, value in [(mode + '-mapping.json', {'taskId': own['taskId'], 'sessionId': own['sessionId'], 'workspaceId': workspace, 'nodeId': node, 'agentSessionId': '01M51AAAAAAAAAAAAAAAAAAAAA'}),
                                ('protected-sleep.json', {'workspaceId': workspace}),
                                ('observer-sleep.json', {'workspaceId': workspace}),
                                ('wake-submitted.json', {'taskId': own['taskId'], 'sessionId': own['sessionId'], 'at': now - 5000}),
                                ('resume-snapshot-request.json', {'taskId':own['taskId'],'sessionId':own['sessionId'],'workspaceId':workspace,'at':now-1000}),
                                ('protected-snapshot.json', {'snapshotId': snapshot, 'snapshotGeneration': 'generation1'})]:
                if not (mode == 'protected-snapshot' and name == 'protected-snapshot.json'):
                    (root / name).write_text(json.dumps(value))
            runtime = 'cf-container' if mode in ['observe','observer-snapshot'] else 'vm'
            if failure == 'missing-wake': (root / 'wake-submitted.json').unlink()
            task = {'id': own['taskId'], 'user_id': 'owner', 'project_id': reader.PROJECT, 'chat_session_id': own['sessionId'], 'workspace_id': workspace, 'output_branch': own['branch'], 'agent_profile_hint': own['agentProfileId'], 'status': 'completed' if mode == 'completion-runtime' else 'sleeping' if mode == 'resume-snapshot' else 'in_progress', 'claimed_warm_node_id': None, 'completed_at': None}
            queries = []

            class Response:
                def __init__(self, value): self.data = json.dumps(value).encode()
                def read(self, size=-1): return self.data if size == -1 else self.data[:size]
                def __enter__(self): return self
                def __exit__(self, *args): pass
            def request(req, timeout):
                if failure == 'transport': raise ValueError(CANARY)
                if req.full_url.endswith('/settings'):
                    return Response({'result': {'bindings': [{'name': 'DATABASE', 'id': 'database'}, {'name': 'VM_AGENT_REQUIRED_VERSION', 'text': 'a'*40 if failure == 'wrong-release' else PIN['agentSource']}]}})
                body = json.loads(req.data);sql = body['sql'];queries.append(sql)
                self.assertTrue(sql.startswith('SELECT '))
                if 'FROM tasks WHERE id=' in sql: rows = [task]
                elif 'FROM nodes WHERE user_id=' in sql: rows = [] if mode == 'resume-snapshot' and failure != 'resume-vm-present' else [{'id': node}]
                elif 'FROM tasks WHERE user_id=' in sql: rows = [{'id': 'foreign'}] if failure == 'foreign-claim' else []
                elif 'FROM workspaces WHERE project_id=' in sql: rows = []
                elif 'FROM workspaces WHERE node_id=' in sql: rows = []
                elif 'FROM workspaces WHERE id=' in sql: rows = [{'id': workspace, 'user_id': 'owner', 'project_id': reader.PROJECT, 'chat_session_id': own['sessionId'], 'node_id': node, 'branch': own['branch'], 'status': 'running'}]
                elif 'FROM nodes WHERE id=' in sql: rows = [{'id': node, 'user_id': 'owner', 'runtime': runtime, 'agent_version': PIN['agentSource'], 'capacity_pool_revision': 74 if failure == 'wrong-pool' else PIN['capacityPoolRevision'], 'status': 'running'}]
                elif 'FROM agent_profiles' in sql: rows = [{'id': own['agentProfileId'], 'user_id': 'owner', 'project_id': reader.PROJECT, 'agent_type': 'wrong' if failure == 'wrong-profile' else ('openai-codex' if mode == 'observe' else 'claude-code'), 'runtime': runtime, 'vm_size_override': None}]
                elif 'FROM session_snapshots' in sql:
                    from datetime import datetime, timezone
                    restored = datetime.fromtimestamp((now - (6000 if failure == 'wrong-time' else 1000))/1000, timezone.utc).isoformat()
                    rows = [{'id': snapshot, 'user_id': 'owner', 'project_id': reader.PROJECT, 'chat_session_id': own['sessionId'], 'workspace_id': workspace, 'runtime': runtime, 'status': 'available', 'degradation': 'none', 'expires_at': '2026-12-01T00:00:00.000Z', 'sleeping_at': '2026-10-16T06:00:00.000Z', 'snapshot_generation': 'generation2' if failure == 'wrong-generation' else 'generation1', 'home_sha256': 'a'*64, 'wip_sha256': 'b'*64, 'recovery_status': None if failure == 'wrong-status' else 'waking' if failure == 'resume-pending-claim' else 'restored', 'recovery_claimed_at': restored if failure in ['resume-pending-claim','resume-retained-claim'] else None, 'recovery_attempt_id':'11111111-2222-4333-8444-555555555555', 'recovery_task_id': own['taskId'], 'recovery_workspace_id': workspace, 'restored_at': restored}]
                    if failure == 'private-row':
                        rows[0].update(snapshot_generation=CANARY, recovery_status=CANARY, recovery_task_id=CANARY, recovery_workspace_id=CANARY, restored_at=CANARY, extra=CANARY)
                    if failure == 'wrong-types': rows[0].update(snapshot_generation=7, restored_at=123)
                else: raise AssertionError('unexpected fixed query')
                return Response({'result': [{'results': rows}]})
            output = io.StringIO()
            with patch.dict(os.environ, {'SAM_PROSPECTIVE_ROOT': folder, 'CF_ACCOUNT_ID': 'synthetic', 'CF_TOKEN': CANARY}), patch.object(reader.sys, 'argv', ['fixed', mode]), patch.object(reader.urllib.request, 'urlopen', request), contextlib.redirect_stdout(output):
                reader.main()
            self.assertNotIn(CANARY, output.getvalue())
            result = json.loads(output.getvalue())
            self.assertEqual(result['ok'], failure in [None, 'wrong-generation'])
            if failure in [None, 'wrong-generation']:
                if failure == 'wrong-generation':
                    projection = json.loads((root / 'wake-check-restore-source.json').read_text())
                    self.assertFalse(projection['predicates']['generationMatches'])
                    self.assertTrue(reader.restore_gate(projection['predicates']))
                source = (root / (mode + '-source.json')).read_bytes()
                artifact = root / (mode + '.json' if mode in ['protected-snapshot', 'observer-snapshot', 'resume-snapshot', 'completion-runtime'] else mode + '-grant.json')
                self.assertEqual(json.loads(artifact.read_text())['sourceEvidenceSha256'], hashlib.sha256(source).hexdigest())
                self.assertNotIn(CANARY, source.decode())
            elif mode == 'wake-check':
                proof_file = root / 'wake-check-restore-source.json'
                original = proof_file.read_bytes()
                failure_file = root / 'wake-check-failure.json'
                original_failure = failure_file.read_bytes()
                proof = json.loads(original)
                self.assertFalse(all(proof['predicates'].values()))
                self.assertTrue(all(type(v) is bool for v in proof['predicates'].values()))
                self.assertEqual(json.loads(original_failure)['sourceEvidenceSha256'], hashlib.sha256(original).hexdigest())
                self.assertEqual(result['diagnostic']['sourceEvidenceSha256'], hashlib.sha256(original).hexdigest())
                self.assertEqual(result['diagnostic']['predicates'], proof['predicates'])
                self.assertEqual(proof_file.stat().st_mode & 0o777, 0o600)
                self.assertEqual(failure_file.stat().st_mode & 0o777, 0o600)
                self.assertFalse((root / 'wake-check-grant.json').exists())
                for path in root.iterdir():
                    if path.is_file(): self.assertNotIn(CANARY, path.read_text())
                # Later source capture becomes valid. Rerunning still cannot replace
                # the failed original or mint a grant from the changed row.
                failure = None
                output = io.StringIO()
                with patch.dict(os.environ, {'SAM_PROSPECTIVE_ROOT': folder, 'CF_ACCOUNT_ID': 'synthetic', 'CF_TOKEN': CANARY}), patch.object(reader.sys, 'argv', ['fixed', mode]), patch.object(reader.urllib.request, 'urlopen', request), contextlib.redirect_stdout(output): reader.main()
                self.assertFalse(json.loads(output.getvalue())['ok'])
                self.assertEqual(proof_file.read_bytes(), original)
                self.assertEqual(failure_file.read_bytes(), original_failure)
                self.assertFalse((root / 'wake-check-grant.json').exists())
            if mode == 'resume-snapshot' and failure is not None:
                self.assertFalse((root / 'resume-snapshot.json').exists())
                self.assertEqual(json.loads((root / 'resume-snapshot-failure.json').read_text())['stage'],'snapshot')
            return result

    def test_pinned_source_contract(self):
        source = subprocess.run(['git', 'show', 'e2c81c045fa16490c7515fa80573418e60ef4017:apps/api/src/db/schema.ts'], capture_output=True, check=True, text=True).stdout
        script = (ROOT / 'prospective-proof.py').read_text()
        variables = {'tasks': 'tasks', 'nodes': 'nodes', 'workspaces': 'workspaces', 'agent_profiles': 'agentProfiles', 'session_snapshots': 'sessionSnapshots'}
        queries = re.findall(r"SELECT ([a-z_,]+) FROM ([a-z_]+)", script)
        self.assertGreater(len(queries), 8)
        for columns, table in queries:
            section = source.split('export const ' + variables[table] + ' =', 1)[1].split('export const ', 1)[0]
            if '...capacityPlacementColumns()' in section:
                section += source.split('const capacityPlacementColumns =', 1)[1].split('// =============================================================================', 1)[0]
            for column in columns.split(','):
                self.assertIn("'" + column + "'", section, (table, column))
        mapping = subprocess.run(['git', 'show', 'e2c81c045fa16490c7515fa80573418e60ef4017:apps/api/src/lib/mappers.ts'], capture_output=True, check=True, text=True).stdout
        task = mapping.split('export function toTaskResponse(', 1)[1].split('export function ', 1)[0]
        self.assertIn('taskMode:', task)
        self.assertNotIn('chatSessionId:', task)
        claim = subprocess.run(['git','show','e2c81c045fa16490c7515fa80573418e60ef4017:apps/api/src/services/session-snapshot-recovery-lifecycle.ts'],capture_output=True,check=True,text=True).stdout
        self.assertIn("recoveryStatus: 'waking'",claim)
        self.assertIn('recoveryClaimedAt: nowIso',claim)
        recovery = subprocess.run(['git','show','e2c81c045fa16490c7515fa80573418e60ef4017:apps/api/src/services/session-recovery.ts'],capture_output=True,check=True,text=True).stdout
        self.assertLess(recovery.index('const claim = await claimSessionSnapshotRecovery'),recovery.index('recoveryTask = await reactivateSleepingTask'))

    def test_fixed_modes(self):
        for mode in reader.MODES:
            with self.subTest(mode=mode): self.invoke(mode)

    def test_rotated_generation_is_observed_not_gated(self):
        self.assertTrue(self.invoke('wake-check', 'wrong-generation')['ok'])

    def test_release_pin_validation(self):
        self.assertEqual(reader.validate_release_pin(PIN), PIN)
        for patch in [{'extra': True}, {'agentSource': 'bad'}, {'publishedBinarySha256': 'a'*40}, {'rawHostShaObserved': True}, {'capacityPoolRevision': True}, {'capacityPoolRevision': 0}]:
            with self.subTest(patch=patch), self.assertRaises(AssertionError):
                reader.validate_release_pin({**PIN, **patch})
        with self.assertRaises(AssertionError): reader.validate_release_pin({})

    def test_concrete_failures(self):
        for mode, failure, stage in [('setup', 'missing-pin', 'configuration'), ('setup', 'malformed-pin', 'configuration'), ('setup', 'wrong-release', 'settings'), ('setup', 'wrong-pool', 'mapping'), ('setup', 'transport', 'settings'), ('setup', 'wrong-profile', 'mapping'), ('setup', 'foreign-claim', 'resource-guards'), *[('wake-check', f, 'restored-generation') for f in ['wrong-status','wrong-time','wrong-types','private-row','missing-wake']]]:
            with self.subTest(failure=failure): self.assertEqual(self.invoke(mode, failure)['stage'], stage)
        for failure in ['resume-vm-present','resume-foreign-task','resume-pending-claim','resume-retained-claim']:
            with self.subTest(failure=failure): self.assertEqual(self.invoke('resume-snapshot',failure)['stage'],'snapshot')


if __name__ == '__main__': unittest.main()
