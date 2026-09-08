"""Offline scenario checks execute the actual guarded SQL in SQLite."""
import copy
import json
import sqlite3
import unittest
from pathlib import Path

import repair


class FakeCloudflare:
    def __init__(self):
        self.db = sqlite3.connect(':memory:')
        self.db.row_factory = sqlite3.Row
        self.bindings = [
            {'name': 'BASE_DOMAIN', 'text': repair.DOMAIN},
            {'name': 'DATABASE', 'type': 'd1', 'id': repair.DATABASE},
            {'name': 'VM_AGENT_REQUIRED_VERSION', 'text': repair.VERSION},
        ]
        self.updates = 0
        self.before_update = None
        self.db.executescript('''
          CREATE TABLE workspaces(id TEXT PRIMARY KEY, user_id TEXT, project_id TEXT,
            chat_session_id TEXT, status TEXT, node_id TEXT, hetzner_server_id TEXT,
            vm_ip TEXT, runtime_deletion_proof TEXT, runtime_deletion_confirmed_at TEXT,
            updated_at TEXT);
          CREATE TABLE tasks(id TEXT PRIMARY KEY, workspace_id TEXT, user_id TEXT,
            project_id TEXT, chat_session_id TEXT, status TEXT, execution_step TEXT,
            auto_provisioned_node_id TEXT, error_message TEXT);
          CREATE TABLE compute_usage(workspace_id TEXT);
          CREATE TABLE session_snapshots(workspace_id TEXT, chat_session_id TEXT);
        ''')
        self.db.execute('INSERT INTO workspaces VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                        repair.IDENTITY + ['stopping', None, None, None, None, None, 'before'])
        self.db.execute('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?)', [
            repair.TASK, *repair.IDENTITY, 'failed', 'workspace_creation', None, repair.ERROR])

    def call(self, path):
        assert path == '/workers/scripts/sam-api-staging/settings'
        return {'bindings': self.bindings}

    def query(self, sql, params):
        if sql == repair.UPDATE:
            self.updates += 1
            if self.before_update:
                self.before_update(self.db)
        cursor = self.db.execute(sql, params)
        return {'success': True, 'results': [dict(row) for row in cursor.fetchall()],
                'meta': {'changes': max(cursor.rowcount, 0)}}


class RepairScenarios(unittest.TestCase):
    def setUp(self):
        self.api = FakeCloudflare()
        self.evidence = json.loads(Path(__file__).with_name('original-evidence.json').read_text())

    def run_repair(self, apply=True):
        return repair.repair(self.api, repair.DOMAIN, self.evidence, apply=apply)

    def test_preview_only_then_apply_then_idempotent_repeat(self):
        self.assertEqual(self.run_repair(False)['outcome'], 'preview_eligible')
        self.assertEqual(self.api.updates, 0)
        result = self.run_repair()
        self.assertEqual(result['changes'], 1)
        self.assertEqual(result['after']['status'], 'stopping')
        self.assertEqual(result['after']['runtime_deletion_proof'], 'workspace_never_started')
        self.assertEqual(self.run_repair()['outcome'], 'already_proven')
        self.assertEqual(self.api.updates, 1)

    def test_environment_and_actual_worker_bindings_must_match(self):
        with self.assertRaises(repair.Refused):
            repair.repair(self.api, 'production.example', self.evidence, True)
        for index, key, value in [(0, 'text', 'production.example'), (1, 'id', 'other-db'),
                                  (1, 'type', 'kv_namespace'), (2, 'text', 'old-version')]:
            with self.subTest(index=index, key=key):
                self.api = FakeCloudflare()
                self.api.bindings[index][key] = value
                with self.assertRaises(repair.Refused):
                    self.run_repair()
                self.assertEqual(self.api.updates, 0)

    def test_original_failure_must_be_exact_and_have_no_runtime(self):
        for field, value in [('nodes', [{'id': 'created-node'}]), ('snapshots', [{}]),
                             ('observed_at', 'different-observation')]:
            with self.subTest(field=field):
                evidence = copy.deepcopy(self.evidence)
                evidence[field] = value
                with self.assertRaises(repair.Refused):
                    repair.repair(self.api, repair.DOMAIN, evidence, True)
        self.evidence['task']['error_message'] = 'unknown provisioning failure'
        with self.assertRaises(repair.Refused):
            self.run_repair()
        self.assertEqual(self.api.updates, 0)

    def test_workspace_identity_and_runtime_guard_matrix(self):
        for column, value in [('id', 'other'), ('user_id', 'other'), ('project_id', 'other'),
                              ('chat_session_id', 'other'), ('status', 'running'),
                              ('node_id', 'node'), ('hetzner_server_id', '123'), ('vm_ip', '1.2.3.4')]:
            with self.subTest(column=column):
                self.api = FakeCloudflare()
                self.api.db.execute(f'UPDATE workspaces SET {column}=?', [value])
                with self.assertRaises(repair.Refused):
                    self.run_repair()
                self.assertEqual(self.api.updates, 0)

    def test_task_identity_provider_error_and_unclaimed_runtime_matrix(self):
        for column, value in [('id', 'other'), ('workspace_id', 'other'), ('user_id', 'other'),
                              ('project_id', 'other'), ('chat_session_id', 'other'),
                              ('status', 'completed'), ('execution_step', 'agent_session'),
                              ('auto_provisioned_node_id', 'node'), ('error_message', 'different')]:
            with self.subTest(column=column):
                self.api = FakeCloudflare()
                self.api.db.execute(f'UPDATE tasks SET {column}=?', [value])
                with self.assertRaises(repair.Refused):
                    self.run_repair()
                self.assertEqual(self.api.updates, 0)

    def test_usage_or_workspace_or_session_snapshot_rejects_repair(self):
        for sql, params in [
            ('INSERT INTO compute_usage VALUES(?)', [repair.WORKSPACE]),
            ('INSERT INTO session_snapshots VALUES(?,?)', [repair.WORKSPACE, 'other']),
            ('INSERT INTO session_snapshots VALUES(?,?)', ['other', repair.SESSION]),
        ]:
            with self.subTest(sql=sql, params=params):
                self.api = FakeCloudflare()
                self.api.db.execute(sql, params)
                with self.assertRaises(repair.Refused):
                    self.run_repair()
                self.assertEqual(self.api.updates, 0)

    def test_unrelated_usage_and_snapshot_do_not_block_exact_repair(self):
        self.api.db.execute('INSERT INTO compute_usage VALUES(?)', ['other'])
        self.api.db.execute('INSERT INTO session_snapshots VALUES(?,?)', ['other', 'other'])
        self.assertEqual(self.run_repair()['changes'], 1)

    def test_partial_or_different_proofs_are_not_overwritten(self):
        for proof, timestamp in [(repair.PROOF, None), (None, 'timestamp'),
                                  ('node_runtime_terminated', 'timestamp')]:
            with self.subTest(proof=proof, timestamp=timestamp):
                self.api = FakeCloudflare()
                self.api.db.execute('UPDATE workspaces SET runtime_deletion_proof=?, '
                                    'runtime_deletion_confirmed_at=?', [proof, timestamp])
                with self.assertRaises(repair.Refused):
                    self.run_repair()
                self.assertEqual(self.api.updates, 0)

    def test_changed_ownership_after_read_is_fenced_by_atomic_update(self):
        self.api.before_update = lambda db: db.execute("UPDATE workspaces SET user_id='other'")
        with self.assertRaises(repair.Refused):
            self.run_repair()
        row = self.api.db.execute('SELECT runtime_deletion_proof FROM workspaces').fetchone()
        self.assertIsNone(row[0])

    def test_snapshot_appearing_after_read_is_fenced_by_atomic_update(self):
        self.api.before_update = lambda db: db.execute(
            'INSERT INTO session_snapshots VALUES(?,?)', [repair.WORKSPACE, repair.SESSION])
        with self.assertRaises(repair.Refused):
            self.run_repair()
        self.assertIsNone(self.api.db.execute('SELECT runtime_deletion_proof FROM workspaces').fetchone()[0])


if __name__ == '__main__':
    unittest.main()
