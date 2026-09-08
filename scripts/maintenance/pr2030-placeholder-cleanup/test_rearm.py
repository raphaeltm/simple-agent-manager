"""Offline SQLite scenarios for the exact snapshot-only counter rearm."""
import copy
import datetime
import hashlib
import json
import sqlite3
import unittest
from pathlib import Path
from unittest.mock import patch

import rearm
from repair import Refused

FIXED_VERSION = '1' * 40


class SnapshotDatabase:
    def __init__(self, evidence):
        self.db = sqlite3.connect(':memory:')
        self.db.row_factory = sqlite3.Row
        # Keep expiration scenarios stable after this short-lived branch is archived.
        now = datetime.datetime(2026, 9, 8, 13, tzinfo=datetime.timezone.utc).timestamp()
        self.db.create_function('unixepoch', 0, lambda: now)
        self.db.execute('CREATE TABLE session_snapshots (' + ','.join(
            field + (' INTEGER' if field == 'sleep_attempts' else ' TEXT')
            for field in rearm.SNAPSHOT_FIELDS) + ',recovery_attempts INTEGER,manifest_json TEXT)')
        fields = rearm.SNAPSHOT_FIELDS + ['recovery_attempts', 'manifest_json']
        values = [evidence['snapshot'][field] for field in rearm.SNAPSHOT_FIELDS] + [3, '{"preserved":"fixture"}']
        self.db.execute('INSERT INTO session_snapshots VALUES (' + ','.join('?' for _ in fields) + ')', values)
        self.db.executescript('''
          CREATE TABLE tasks(id TEXT,user_id TEXT,project_id TEXT,triggered_by TEXT,
            recovery_source_task_id TEXT,status TEXT,error_message TEXT,workspace_id TEXT,
            chat_session_id TEXT,execution_step TEXT,claimed_warm_node_id TEXT,
            claimed_warm_node_at TEXT,auto_provisioned_node_id TEXT);
          CREATE TABLE nodes(id TEXT,user_id TEXT,runtime_incarnation_id TEXT,status TEXT,
            cloud_provider TEXT,error_message TEXT,provider_instance_id TEXT,ip_address TEXT,
            last_heartbeat_at TEXT,agent_ready_at TEXT,backend_dns_record_id TEXT,
            credential_source TEXT,placement_credential_source TEXT,credential_attribution_source TEXT,
            placement_credential_fingerprint TEXT);
          CREATE TABLE workspaces(id TEXT,node_id TEXT,chat_session_id TEXT,status TEXT);
          CREATE TABLE compute_usage(node_id TEXT);
        ''')
        for task, node, incarnation in rearm.ATTEMPTS:
            self.db.execute('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', [
                task, rearm.USER, rearm.PROJECT, 'session-recovery', rearm.SOURCE_TASK,
                'failed', rearm.ERROR, None, None, None, None, None, node])
            self.db.execute('INSERT INTO nodes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [
                node, rearm.USER, incarnation, 'destroying', 'hetzner', '[hetzner] ' + rearm.ERROR,
                None, None, None, None, None, 'user', 'platform', 'platform', None])
        self.version = FIXED_VERSION
        self.updates = 0
        self.before_update = None

    def call(self, path):
        assert path == '/workers/scripts/sam-api-staging/settings'
        return {'bindings': [
            {'name': 'BASE_DOMAIN', 'text': rearm.DOMAIN},
            {'name': 'DATABASE', 'type': 'd1', 'id': rearm.DATABASE},
            {'name': 'VM_AGENT_REQUIRED_VERSION', 'text': self.version},
        ]}

    def query(self, sql, params):
        mutation = 'UPDATE session_snapshots' in sql
        if mutation:
            self.updates += 1
            if self.before_update:
                self.before_update(self.db)
        cursor = self.db.execute(sql, params)
        rows = [dict(row) for row in cursor.fetchall()]
        return {'results': rows, 'meta': {'changes': self.db.execute('SELECT changes()').fetchone()[0]
                                         if mutation else 0}}


class SnapshotRearmScenarios(unittest.TestCase):
    def setUp(self):
        self.evidence = json.loads(Path(__file__).with_name('recovery-evidence.json').read_text())
        self.evidence['manifest_json_sha256'] = hashlib.sha256(b'{"preserved":"fixture"}').hexdigest()
        self.api = SnapshotDatabase(self.evidence)
        self.version_patch = patch.object(rearm, 'REQUIRED_VERSION', FIXED_VERSION)
        self.version_patch.start()
        self.addCleanup(self.version_patch.stop)

    def run_rearm(self, apply=True):
        return rearm.rearm(self.api, rearm.DOMAIN, self.evidence, apply)

    def test_preview_apply_idempotency_changes_only_attempt_counter(self):
        before = dict(self.api.db.execute('SELECT * FROM session_snapshots').fetchone())
        self.assertEqual(self.run_rearm(False)['outcome'], 'preview_eligible')
        self.assertEqual(self.api.updates, 0)
        result = self.run_rearm()
        self.assertEqual((result['changes'], result['after_attempts']), (1, 0))
        self.assertEqual(dict(self.api.db.execute('SELECT * FROM session_snapshots').fetchone()),
                         {**before, 'recovery_attempts': 0})
        self.assertEqual(self.run_rearm()['outcome'], 'already_rearmed')
        self.assertEqual(self.api.updates, 1)

    def test_unconfigured_old_or_unmatched_worker_refuses_even_preview(self):
        for version in [None, rearm.VERSION, 'not-a-sha', '2' * 40]:
            with self.subTest(version=version), patch.object(rearm, 'REQUIRED_VERSION', version):
                with self.assertRaises(Refused):
                    self.run_rearm(False)
        self.assertEqual(self.api.updates, 0)

    def test_snapshot_identity_generation_hash_and_lifecycle_guards(self):
        mutations = [('id', 'other'), ('user_id', 'other'), ('project_id', 'other'),
                     ('chat_session_id', 'other'), ('snapshot_generation', 'next'),
                     ('home_sha256', 'other'), ('wip_sha256', 'other'), ('home_r2_key', 'other'),
                     ('status', 'failed'), ('sleep_status', 'awake'), ('recovery_status', 'waking'),
                     ('recovery_task_id', 'other'), ('recovery_error', 'different'),
                     ('recovery_workspace_id', 'workspace'), ('recovery_claimed_at', 'now')]
        for column, value in mutations:
            with self.subTest(column=column):
                self.api = SnapshotDatabase(self.evidence)
                self.api.db.execute(f'UPDATE session_snapshots SET {column}=?', [value])
                with self.assertRaises(Refused):
                    self.run_rearm()
                self.assertEqual(self.api.updates, 0)

    def test_expired_snapshot_and_partial_budget_refuse(self):
        self.api.db.create_function('unixepoch', 0, lambda: 9999999999)
        with self.assertRaises(Refused):
            self.run_rearm()
        for attempts in [1, 2, 4]:
            self.api = SnapshotDatabase(self.evidence)
            self.api.db.execute('UPDATE session_snapshots SET recovery_attempts=?', [attempts])
            with self.assertRaises(Refused):
                self.run_rearm()
            self.assertEqual(self.api.updates, 0)

    def test_all_three_failed_tasks_and_pre_provider_incarnations_required(self):
        for table, column, value in [
            ('tasks', 'status', 'in_progress'), ('tasks', 'error_message', 'other'),
            ('tasks', 'workspace_id', 'workspace'), ('tasks', 'auto_provisioned_node_id', 'other'),
            ('nodes', 'runtime_incarnation_id', 'new-incarnation'), ('nodes', 'provider_instance_id', '123'),
            ('nodes', 'ip_address', '1.2.3.4'), ('nodes', 'credential_source', 'platform'),
            ('nodes', 'placement_credential_fingerprint', 'claimed'),
        ]:
            with self.subTest(table=table, column=column):
                self.api = SnapshotDatabase(self.evidence)
                self.api.db.execute(f'UPDATE {table} SET {column}=? WHERE rowid=2', [value])
                with self.assertRaises(Refused):
                    self.run_rearm()
                self.assertEqual(self.api.updates, 0)

    def test_active_workspace_usage_or_other_recovery_refuses(self):
        sqls = [
            ('INSERT INTO workspaces VALUES(?,?,?,?)', ['w', rearm.ATTEMPTS[0][1], 'other', 'running']),
            ('INSERT INTO workspaces VALUES(?,?,?,?)', ['w', 'other', rearm.SESSION, 'creating']),
            ('INSERT INTO compute_usage VALUES(?)', [rearm.ATTEMPTS[1][1]]),
            ("INSERT INTO tasks(id,user_id,project_id,triggered_by,recovery_source_task_id,status) "
             "VALUES(?,?,?,'session-recovery',?,'queued')", ['new', rearm.USER, rearm.PROJECT, rearm.SOURCE_TASK]),
        ]
        for sql, params in sqls:
            with self.subTest(sql=sql):
                self.api = SnapshotDatabase(self.evidence)
                self.api.db.execute(sql, params)
                with self.assertRaises(Refused):
                    self.run_rearm()
                self.assertEqual(self.api.updates, 0)

    def test_manifest_change_is_rejected_without_printing_manifest(self):
        self.api.db.execute("UPDATE session_snapshots SET manifest_json='private-new-data'")
        with self.assertRaisesRegex(Refused, 'manifest hash mismatch'):
            self.run_rearm()
        self.assertEqual(self.api.updates, 0)

    def test_claim_manifest_and_provider_changes_between_read_and_update_are_fenced(self):
        for sql in ["UPDATE session_snapshots SET recovery_status='waking'",
                    "UPDATE session_snapshots SET manifest_json='new-manifest'",
                    "UPDATE nodes SET placement_credential_fingerprint='claimed' WHERE rowid=1"]:
            with self.subTest(sql=sql):
                self.api = SnapshotDatabase(self.evidence)
                self.api.before_update = lambda db, query=sql: db.execute(query)
                with self.assertRaises(Refused):
                    self.run_rearm()
                self.assertEqual(self.api.db.execute('SELECT recovery_attempts FROM session_snapshots').fetchone()[0], 3)

    def test_counter_reset_winner_is_not_repeated(self):
        self.api.before_update = lambda db: db.execute('UPDATE session_snapshots SET recovery_attempts=0')
        with self.assertRaises(Refused):
            self.run_rearm()
        self.api.before_update = None
        self.assertEqual(self.run_rearm()['outcome'], 'already_rearmed')
        self.assertEqual(self.api.updates, 1)

    def test_d1_bind_limit_kept_for_final_atomic_sql(self):
        _, params = rearm.sql_and_params(self.evidence)
        self.assertLessEqual(len(params) + 1, 100)


if __name__ == '__main__':
    unittest.main()
