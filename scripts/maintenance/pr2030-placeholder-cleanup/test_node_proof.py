"""Real SQLite CAS scenarios for the three exact pre-claim node proofs."""
import json
import sqlite3
import unittest
from pathlib import Path
from unittest.mock import patch

import node_proof
import rearm
from repair import Refused


class NodeDatabase:
    def __init__(self, evidence):
        self.db = sqlite3.connect(':memory:')
        self.db.row_factory = sqlite3.Row
        fields = ['id', 'status', 'runtime_incarnation_id', 'created_at', 'updated_at',
                  'runtime_termination_confirmed_at'] + node_proof.COMMON_FIELDS
        self.db.execute('CREATE TABLE nodes(' + ','.join(field + (
            ' INTEGER' if field in ('placement_credential_version', 'capacity_pool_revision') else ' TEXT')
            for field in fields) + ')')
        for row in evidence['nodes']:
            self.db.execute('INSERT INTO nodes VALUES(' + ','.join('?' for _ in fields) + ')',
                            [row.get(field, 'before') for field in fields])
        self.db.executescript('''
          CREATE TABLE tasks(id TEXT,user_id TEXT,project_id TEXT,triggered_by TEXT,
            recovery_source_task_id TEXT,status TEXT,error_message TEXT,workspace_id TEXT,
            chat_session_id TEXT,execution_step TEXT,claimed_warm_node_id TEXT,
            claimed_warm_node_at TEXT,auto_provisioned_node_id TEXT);
          CREATE TABLE workspaces(node_id TEXT);
          CREATE TABLE compute_usage(node_id TEXT);
          CREATE TABLE session_snapshots(node_id TEXT);
        ''')
        for task, node, _ in rearm.ATTEMPTS:
            self.db.execute('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', [
                task, rearm.USER, rearm.PROJECT, 'session-recovery', rearm.SOURCE_TASK,
                'failed', rearm.ERROR, None, None, None, None, None, node])
        self.updates = 0
        self.before_update = None

    def call(self, path):
        assert path == '/workers/scripts/sam-api-staging/settings'
        return {'bindings': [
            {'name': 'BASE_DOMAIN', 'text': rearm.DOMAIN},
            {'name': 'DATABASE', 'type': 'd1', 'id': rearm.DATABASE},
            {'name': 'VM_AGENT_REQUIRED_VERSION', 'text': rearm.REQUIRED_VERSION},
        ]}

    def query(self, sql, params):
        mutation = 'UPDATE nodes SET' in sql
        if mutation:
            self.updates += 1
            if self.before_update:
                self.before_update(self.db)
        cursor = self.db.execute(sql, params)
        rows = [dict(row) for row in cursor.fetchall()]
        changes = self.db.execute('SELECT changes()').fetchone()[0] if mutation else 0
        return {'results': rows, 'meta': {'changes': changes}}


class NodeProofScenarios(unittest.TestCase):
    def setUp(self):
        self.evidence = json.loads(Path(__file__).with_name('node-proof-evidence.json').read_text())
        self.api = NodeDatabase(self.evidence)

    def run_repair(self, apply=True):
        return node_proof.repair_nodes(self.api, rearm.DOMAIN, self.evidence, apply)

    def test_preview_then_exact_three_row_update_and_idempotency(self):
        before = [dict(row) for row in self.api.db.execute('SELECT * FROM nodes ORDER BY id')]
        self.assertEqual(self.run_repair(False)['outcome'], 'preview_eligible')
        self.assertEqual(self.api.updates, 0)
        audit = self.run_repair()
        self.assertEqual((audit['outcome'], audit['changes']), ('node_proofs_persisted', 3))
        at = audit['after_proof_timestamps'][0]
        after = [dict(row) for row in self.api.db.execute('SELECT * FROM nodes ORDER BY id')]
        self.assertEqual(after, [{**row, 'runtime_termination_confirmed_at': at, 'updated_at': at}
                                 for row in before])
        self.assertEqual(self.run_repair()['outcome'], 'already_proven')
        self.assertEqual(self.api.updates, 1)

    def test_one_changed_incarnation_credential_or_native_identity_blocks_all_three(self):
        for column, value in [('runtime_incarnation_id', 'replacement'), ('credential_source', 'platform'),
                              ('placement_credential_fingerprint', 'claimed'),
                              ('provider_instance_type', 'cx33'), ('capacity_pool_revision', 15),
                              ('created_at', 'different'), ('provider_instance_id', '123'),
                              ('ip_address', '1.2.3.4'), ('last_heartbeat_at', 'now')]:
            with self.subTest(column=column):
                self.api = NodeDatabase(self.evidence)
                self.api.db.execute(f'UPDATE nodes SET {column}=? WHERE rowid=2', [value])
                with self.assertRaises(Refused):
                    self.run_repair()
                self.assertEqual(self.api.updates, 0)
                self.assertEqual(self.api.db.execute('SELECT COUNT(*) FROM nodes WHERE '
                                                    'runtime_termination_confirmed_at IS NOT NULL').fetchone()[0], 0)

    def test_changed_task_or_workspace_usage_snapshot_prevents_proof(self):
        scenarios = [("UPDATE tasks SET status='in_progress' WHERE rowid=1", []),
                     ("UPDATE tasks SET error_message='other' WHERE rowid=1", []),
                     ("UPDATE tasks SET workspace_id='workspace' WHERE rowid=1", [])]
        scenarios += [(f'INSERT INTO {table} VALUES(?)', [rearm.ATTEMPTS[0][1]])
                      for table in ('workspaces', 'compute_usage', 'session_snapshots')]
        for sql, params in scenarios:
            with self.subTest(sql=sql):
                self.api = NodeDatabase(self.evidence)
                self.api.db.execute(sql, params)
                with self.assertRaises(Refused):
                    self.run_repair()
                self.assertEqual(self.api.updates, 0)

    def test_partial_proof_requires_review(self):
        self.api.db.execute("UPDATE nodes SET runtime_termination_confirmed_at='earlier' WHERE rowid=1")
        with self.assertRaisesRegex(Refused, 'Partial node proof'):
            self.run_repair()
        self.assertEqual(self.api.updates, 0)

    def test_provider_claim_or_proof_race_cannot_partially_repair(self):
        for sql in ["UPDATE nodes SET credential_source='platform' WHERE rowid=1",
                    "UPDATE nodes SET runtime_incarnation_id='replacement' WHERE rowid=1",
                    "UPDATE nodes SET runtime_termination_confirmed_at='winner' WHERE rowid=1"]:
            with self.subTest(sql=sql):
                self.api = NodeDatabase(self.evidence)
                self.api.before_update = lambda db, query=sql: db.execute(query)
                with self.assertRaises(Refused):
                    self.run_repair()
                self.assertEqual(self.api.db.execute('SELECT COUNT(*) FROM nodes WHERE rowid!=1 '
                                                    'AND runtime_termination_confirmed_at IS NOT NULL').fetchone()[0], 0)

    def test_unrelated_node_is_never_touched(self):
        self.api.db.execute("INSERT INTO nodes(id,status) VALUES('unrelated','destroying')")
        self.assertEqual(self.run_repair()['changes'], 3)
        row = self.api.db.execute("SELECT runtime_termination_confirmed_at FROM nodes WHERE id='unrelated'").fetchone()
        self.assertIsNone(row[0])

    def test_requires_corrected_worker_and_bounded_parameters(self):
        with patch.object(rearm, 'REQUIRED_VERSION', rearm.VERSION):
            with self.assertRaises(Refused):
                self.run_repair(False)
        _, params = node_proof.sql_and_params(self.evidence)
        self.assertLessEqual(len(params) + 2, 100)


if __name__ == '__main__':
    unittest.main()
