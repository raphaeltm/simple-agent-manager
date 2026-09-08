"""Offline real-SQL proof, helper, concurrency and exact-counter repair scenarios."""
import copy
import datetime
import hashlib
import json
import sqlite3
import unittest
from pathlib import Path
from unittest.mock import patch

import retry_provider_recovery as retry
from repair import Refused
from test_rearm import SnapshotDatabase

MANIFEST = '{"preserved":"fixture"}'
HELPER = {'workspace_id': 'reviewed-helper', 'id': 'helper-node',
          'runtime_incarnation_id': 'helper-incarnation', 'provider_instance_id': '12345',
          'provider_instance_type': 'cx23'}


class ProviderDatabase(SnapshotDatabase):
    def __init__(self, evidence):
        self.db = sqlite3.connect(':memory:')
        self.db.row_factory = sqlite3.Row
        now = datetime.datetime(2026, 9, 8, 13, 40, tzinfo=datetime.timezone.utc).timestamp()
        self.db.create_function('unixepoch', 0, lambda: now)
        snapshot = {**evidence['snapshot'], 'manifest_json': MANIFEST}
        self.seed('session_snapshots', [snapshot])
        self.seed('tasks', evidence['tasks'])
        helper = {**dict.fromkeys(evidence['nodes'][0]), **HELPER,
                  'user_id': retry.USER, 'status': 'running', 'runtime': 'vm',
                  'node_class': 'managed', 'node_role': 'workspace', 'cloud_provider': 'hetzner',
                  'vm_location': 'nbg1', 'ip_address': '203.0.113.1',
                  'agent_ready_at': '2026-09-08T13:39:00Z', 'last_heartbeat_at': '2026-09-08T13:40:00Z',
                  'observed_hardware_source': 'observed', 'observed_provider_instance_type': 'cx23',
                  'observed_provider_instance_vcpu_count': 2, 'observed_provider_instance_memory_mb': 4096,
                  'agent_version': retry.REQUIRED_VERSION, 'health_status': 'healthy',
                  'capacity_pool_id': 'cap-pool-default:installation', 'capacity_pool_scope': 'installation'}
        del helper['workspace_id']
        self.seed('nodes', evidence['nodes'] + [helper])
        self.seed('workspaces', [{'id': HELPER['workspace_id'], 'node_id': HELPER['id'],
                  'user_id': retry.USER, 'project_id': retry.PROJECT, 'status': 'running',
                  'chat_session_id': 'helper-chat', 'resolved_reservation_json':
                  json.dumps({'cpuMillis': 250, 'memoryMb': 512, 'maxCoTenants': 3})}])
        self.db.execute('CREATE TABLE compute_usage(node_id TEXT)')
        self.version = retry.REQUIRED_VERSION
        self.updates = 0
        self.before_update = None

    def seed(self, table, rows):
        fields = sorted(set().union(*(row.keys() for row in rows)))
        integer = {'recovery_attempts', 'sleep_attempts', 'observed_provider_instance_vcpu_count',
                   'observed_provider_instance_memory_mb'}
        self.db.execute('CREATE TABLE ' + table + '(' + ','.join(
            field + (' INTEGER' if field in integer else ' TEXT') for field in fields) + ')')
        for row in rows:
            self.db.execute('INSERT INTO ' + table + ' VALUES (' + ','.join('?' for _ in fields) + ')',
                            [row.get(field) for field in fields])


class ProviderRecoveryRetryScenarios(unittest.TestCase):
    def setUp(self):
        self.evidence = json.loads(Path(__file__).with_name('provider-recovery-evidence.json').read_text())
        original = retry.read_original_evidence()
        digest = hashlib.sha256(MANIFEST.encode()).hexdigest()
        original['manifest_json_sha256'] = digest
        self.evidence['manifest_json_sha256'] = digest
        self.evidence['helper'] = HELPER.copy()
        original_patch = patch.object(retry, 'read_original_evidence', return_value=original)
        original_patch.start()
        self.addCleanup(original_patch.stop)
        self.api = ProviderDatabase(self.evidence)

    def run_retry(self, apply=True):
        return retry.retry(self.api, retry.DOMAIN, self.evidence, apply)

    def test_preview_atomic_apply_and_idempotency_change_only_counter(self):
        tables = ['session_snapshots', 'tasks', 'nodes', 'workspaces', 'compute_usage']
        before = {t: [dict(row) for row in self.api.db.execute('SELECT * FROM ' + t)] for t in tables}
        self.assertEqual(self.run_retry(False)['outcome'], 'preview_eligible')
        self.assertEqual(self.api.updates, 0)
        self.assertEqual(self.run_retry()['changes'], 1)
        expected = copy.deepcopy(before)
        expected['session_snapshots'][0]['recovery_attempts'] = 0
        self.assertEqual({t: [dict(row) for row in self.api.db.execute('SELECT * FROM ' + t)] for t in tables}, expected)
        self.assertEqual(self.run_retry()['outcome'], 'already_rearmed')
        self.assertEqual(self.api.updates, 1)

    def test_unreviewed_helper_and_wrong_worker_refuse_even_preview(self):
        self.evidence['helper'] = None
        with self.assertRaisesRegex(Refused, 'captured and reviewed'):
            self.run_retry(False)
        self.evidence['helper'] = HELPER.copy()
        self.api.version = 'f' * 40
        with self.assertRaisesRegex(Refused, 'version'):
            self.run_retry(False)
        self.assertEqual(self.api.updates, 0)

    def test_changed_provider_proof_incarnation_or_error_refuses(self):
        for column, value in [('provider_instance_id', 'paid-vm'), ('ip_address', '203.0.113.4'),
                              ('runtime_termination_confirmed_at', None),
                              ('runtime_termination_confirmed_at', 'different-proof'),
                              ('runtime_incarnation_id', 'new'), ('error_message', 'other'),
                              ('created_at', 'different'), ('status', 'running')]:
            with self.subTest(column=column, value=value):
                self.api = ProviderDatabase(self.evidence)
                self.api.db.execute('UPDATE nodes SET ' + column + '=? WHERE id=?', [value, retry.ATTEMPTS[1][1]])
                with self.assertRaises(Refused):
                    self.run_retry()
                self.assertEqual(self.api.updates, 0)

    def test_helper_identity_health_capacity_and_freshness_fail_closed(self):
        for column, value in [('runtime_incarnation_id', 'new'), ('provider_instance_id', 'different'),
                              ('health_status', 'unhealthy'), ('observed_hardware_source', None),
                              ('observed_provider_instance_type', 'different'),
                              ('observed_provider_instance_memory_mb', 1024), ('observed_provider_instance_vcpu_count', 1),
                              ('last_heartbeat_at', '2026-09-08T13:00:00Z'), ('agent_version', 'old'),
                              ('runtime_termination_confirmed_at', 'destroyed'), ('node_class', 'user-owned')]:
            with self.subTest(column=column):
                self.api = ProviderDatabase(self.evidence)
                self.api.db.execute('UPDATE nodes SET ' + column + '=? WHERE id=?', [value, HELPER['id']])
                with self.assertRaises(Refused):
                    self.run_retry()
                self.assertEqual(self.api.updates, 0)

    def test_usage_attached_workspace_and_concurrent_recovery_are_rejected(self):
        mutations = [
            "INSERT INTO compute_usage VALUES('" + retry.ATTEMPTS[0][1] + "')",
            "INSERT INTO workspaces(id,node_id,status) VALUES('attached','" + retry.ATTEMPTS[0][1] + "','deleted')",
            "INSERT INTO workspaces(id,node_id,status) VALUES('busy','helper-node','creating')",
            "UPDATE tasks SET status='in_progress' WHERE id='" + retry.ATTEMPTS[2][0] + "'",
        ]
        for sql in mutations:
            with self.subTest(sql=sql):
                self.api = ProviderDatabase(self.evidence)
                self.api.db.execute(sql)
                with self.assertRaises(Refused):
                    self.run_retry()
                self.assertEqual(self.api.updates, 0)

    def test_snapshot_generation_manifest_and_partial_counter_refuse(self):
        for column, value in [('snapshot_generation', 'next'), ('manifest_json', 'other'),
                              ('recovery_attempts', 1), ('recovery_attempts', 2), ('recovery_attempts', 4),
                              ('recovery_status', 'waking'), ('recovery_claimed_at', 'now')]:
            with self.subTest(column=column):
                self.api = ProviderDatabase(self.evidence)
                self.api.db.execute('UPDATE session_snapshots SET ' + column + '=?', [value])
                with self.assertRaises(Refused):
                    self.run_retry()
                self.assertEqual(self.api.updates, 0)

    def test_atomic_claim_rechecks_proof_incarnation_generation_and_helper(self):
        mutations = [
            "UPDATE session_snapshots SET recovery_status='waking'",
            "UPDATE session_snapshots SET snapshot_generation='next'",
            "UPDATE session_snapshots SET manifest_json='new-manifest'",
            "UPDATE nodes SET runtime_termination_confirmed_at=NULL WHERE id='" + retry.ATTEMPTS[0][1] + "'",
            "UPDATE nodes SET runtime_incarnation_id='new' WHERE id='" + retry.ATTEMPTS[0][1] + "'",
            "UPDATE nodes SET provider_instance_id='paid' WHERE id='" + retry.ATTEMPTS[0][1] + "'",
            "UPDATE nodes SET status='destroying' WHERE id='helper-node'",
            "UPDATE nodes SET runtime_incarnation_id='new' WHERE id='helper-node'",
        ]
        for sql in mutations:
            with self.subTest(sql=sql):
                self.api = ProviderDatabase(self.evidence)
                self.api.before_update = lambda db, query=sql: db.execute(query)
                with self.assertRaises(Refused):
                    self.run_retry()
                self.assertEqual(self.api.db.execute('SELECT recovery_attempts FROM session_snapshots').fetchone()[0], 3)

    def test_new_concurrent_recovery_blocks_preflight_and_atomic_claim(self):
        for match in ('recovery_source_task_id', 'chat_session_id'):
            for atomic in (False, True):
                with self.subTest(match=match, atomic=atomic):
                    self.api = ProviderDatabase(self.evidence)
                    value = retry.rearm.SOURCE_TASK if match == 'recovery_source_task_id' else retry.rearm.SESSION
                    sql = ("INSERT INTO tasks(id,user_id,project_id,triggered_by,status," + match + ") "
                           "VALUES(?,?,?,'session-recovery','queued',?)")
                    params = ['concurrent-recovery', retry.USER, retry.PROJECT, value]
                    if atomic:
                        self.api.before_update = lambda db: db.execute(sql, params)
                    else:
                        self.api.db.execute(sql, params)
                    with self.assertRaises(Refused):
                        self.run_retry()
                    self.assertEqual(self.api.db.execute(
                        'SELECT recovery_attempts FROM session_snapshots').fetchone()[0], 3)
                    self.assertEqual(self.api.updates, int(atomic))

    def test_final_query_stays_below_d1_binding_limit(self):
        _, params = retry.sql_and_params(self.evidence, HELPER)
        self.assertLessEqual(len(params) + 1, 100)


if __name__ == '__main__':
    unittest.main()
