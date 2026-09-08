"""Real SQLite guards for the exact helper placeholder proof transfer."""
import datetime
import sqlite3
import unittest
from unittest.mock import patch

import helper_workspace_proof as proof
from repair import Refused


class Database:
    def __init__(self):
        self.base = 'https://api.cloudflare.com/client/v4/accounts/' + proof.ACCOUNT
        self.db = sqlite3.connect(':memory:')
        self.db.row_factory = sqlite3.Row
        self.db.executescript('''
          CREATE TABLE workspaces(id TEXT PRIMARY KEY,user_id TEXT,project_id TEXT,
            chat_session_id TEXT,created_at TEXT,status TEXT,error_message TEXT,node_id TEXT,
            hetzner_server_id TEXT,vm_ip TEXT,runtime_deletion_proof TEXT,
            runtime_deletion_confirmed_at TEXT,updated_at TEXT,metadata TEXT);
          CREATE TABLE nodes(id TEXT PRIMARY KEY,user_id TEXT,runtime_incarnation_id TEXT,
            provider_instance_id TEXT,created_at TEXT,status TEXT,runtime TEXT,node_class TEXT,
            node_role TEXT,cloud_provider TEXT,provider_instance_type TEXT,vm_location TEXT,
            credential_source TEXT,placement_credential_reference TEXT,
            placement_credential_fingerprint TEXT,runtime_termination_confirmed_at TEXT,metadata TEXT);
          CREATE TABLE tasks(id TEXT PRIMARY KEY,user_id TEXT,project_id TEXT,workspace_id TEXT,
            chat_session_id TEXT,created_at TEXT,status TEXT,error_message TEXT,execution_step TEXT,
            auto_provisioned_node_id TEXT,task_mode TEXT,triggered_by TEXT,metadata TEXT);
          CREATE TABLE compute_usage(workspace_id TEXT);
          CREATE TABLE session_snapshots(workspace_id TEXT,chat_session_id TEXT);
        ''')
        self.at = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=1)).isoformat()
        self.db.execute('INSERT INTO workspaces VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [
            proof.WORKSPACE, proof.USER, proof.PROJECT, proof.SESSION, proof.CREATED,
            'error', proof.WORKSPACE_ERROR, None, None, None, None, None, 'unchanged', 'workspace-data'])
        self.db.execute('INSERT INTO nodes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [
            proof.NODE, proof.USER, proof.INCARNATION, proof.PROVIDER, proof.NODE_CREATED,
            'deleted', 'vm', 'managed', 'workspace', 'hetzner', 'cx23', 'nbg1', 'platform',
            proof.CREDENTIAL, proof.FINGERPRINT, self.at, 'node-data'])
        self.db.execute('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', [
            proof.TASK, proof.USER, proof.PROJECT, proof.WORKSPACE, proof.SESSION, proof.CREATED,
            'failed', proof.TASK_ERROR, None, None, 'conversation', 'user', 'task-data'])
        self.db.execute("INSERT INTO workspaces(id,status,metadata) VALUES('sentinel','error','untouched')")
        self.updates = 0
        self.before_update = None
        self.after_update = None
        self.version = proof.REQUIRED_VERSION
        self.installation = proof.INSTALLATION

    def call(self, path):
        assert path == '/workers/scripts/' + proof.WORKER + '/settings'
        return {'bindings': [
            {'name': 'BASE_DOMAIN', 'text': proof.DOMAIN},
            {'name': 'DATABASE', 'type': 'd1', 'id': proof.DATABASE},
            {'name': 'SAM_INSTALLATION_ID', 'text': self.installation},
            {'name': 'VM_AGENT_REQUIRED_VERSION', 'text': self.version},
        ]}

    def query(self, sql, params):
        mutation = sql.lstrip().startswith('UPDATE')
        if mutation:
            self.updates += 1
            if self.before_update:
                self.before_update(self.db)
        cursor = self.db.execute(sql, params)
        rows = [dict(row) for row in cursor.fetchall()]
        changes = self.db.execute('SELECT changes()').fetchone()[0] if mutation else 0
        if mutation and self.after_update:
            self.after_update(self.db)
        return {'results': rows, 'meta': {'changes': changes}}

    def rows(self, table):
        return [dict(row) for row in self.db.execute('SELECT * FROM ' + table + ' ORDER BY id')]


class HelperProofScenarios(unittest.TestCase):
    def setUp(self):
        self.api = Database()

    def run_transfer(self, apply=True):
        return proof.transfer_proof(self.api, proof.DOMAIN, apply)

    def test_preview_default_changes_nothing(self):
        before = self.api.rows('workspaces')
        self.assertEqual(proof.transfer_proof(self.api, proof.DOMAIN)['outcome'], 'preview_eligible')
        self.assertEqual(self.api.rows('workspaces'), before)
        self.assertEqual(self.api.updates, 0)

    def test_copies_exact_proof_only_and_idempotency_is_read_only(self):
        before = {table: self.api.rows(table) for table in ['workspaces', 'nodes', 'tasks']}
        result = self.run_transfer()
        self.assertEqual(result['outcome'], 'proof_transferred')
        self.assertEqual(result['changes'], 1)
        expected = [{**row, 'runtime_deletion_proof': proof.PROOF,
                     'runtime_deletion_confirmed_at': self.api.at}
                    if row['id'] == proof.WORKSPACE else row for row in before['workspaces']]
        self.assertEqual(self.api.rows('workspaces'), expected)
        for table in ['nodes', 'tasks']:
            self.assertEqual(self.api.rows(table), before[table])
        self.assertEqual(self.run_transfer()['outcome'], 'already_proven')
        self.assertEqual(self.api.updates, 1)

    def test_live_node_always_refuses_even_if_stale_proof_exists(self):
        for status, marker in [('running', None), ('running', self.api.at),
                               ('destroying', self.api.at), ('deleted', None)]:
            with self.subTest(status=status, marker=marker):
                self.api = Database()
                self.api.db.execute('UPDATE nodes SET status=?,runtime_termination_confirmed_at=?', [status, marker])
                with self.assertRaises(Refused):
                    self.run_transfer(False)
                self.assertEqual(self.api.updates, 0)

    def test_wrong_node_identity_or_invalid_proof_refuses(self):
        for column, value in [('runtime_incarnation_id', 'replacement'), ('provider_instance_id', 'other'),
                              ('user_id', 'other'), ('created_at', 'other'), ('node_class', 'external'),
                              ('placement_credential_fingerprint', 'other'),
                              ('runtime_termination_confirmed_at', 'not-a-date'),
                              ('runtime_termination_confirmed_at', '2026-09-08T13:00:00Z'),
                              ('runtime_termination_confirmed_at', '2099-01-01T00:00:00Z')]:
            with self.subTest(column=column, value=value):
                self.api = Database()
                self.api.db.execute(f'UPDATE nodes SET {column}=?', [value])
                with self.assertRaises(Refused):
                    self.run_transfer()
                self.assertEqual(self.api.updates, 0)

    def test_wrong_workspace_or_task_identity_refuses(self):
        scenarios = [('workspaces', 'node_id', proof.NODE), ('workspaces', 'status', 'running'),
                     ('workspaces', 'error_message', 'different'), ('workspaces', 'user_id', 'other'),
                     ('workspaces', 'chat_session_id', 'other'), ('tasks', 'status', 'in_progress'),
                     ('tasks', 'workspace_id', 'other'), ('tasks', 'project_id', 'other'),
                     ('tasks', 'auto_provisioned_node_id', proof.NODE),
                     ('tasks', 'task_mode', 'task'), ('tasks', 'error_message', 'other')]
        for table, column, value in scenarios:
            with self.subTest(table=table, column=column):
                self.api = Database()
                self.api.db.execute(f'UPDATE {table} SET {column}=?', [value])
                with self.assertRaises(Refused):
                    self.run_transfer()
                self.assertEqual(self.api.updates, 0)

    def test_usage_snapshot_and_other_active_workspace_refuse(self):
        scenarios = [('INSERT INTO compute_usage VALUES(?)', [proof.WORKSPACE]),
                     ('INSERT INTO session_snapshots VALUES(?,NULL)', [proof.WORKSPACE]),
                     ('INSERT INTO session_snapshots VALUES(NULL,?)', [proof.SESSION]),
                     ("UPDATE workspaces SET node_id=?,status='running' WHERE id='sentinel'", [proof.NODE])]
        for sql, params in scenarios:
            with self.subTest(sql=sql):
                self.api = Database()
                self.api.db.execute(sql, params)
                with self.assertRaises(Refused):
                    self.run_transfer()
                self.assertEqual(self.api.updates, 0)

    def test_conflicting_or_partial_proof_never_overwritten(self):
        for marker, timestamp in [(proof.PROOF, None), (None, self.api.at),
                                   ('workspace_never_started', self.api.at), (proof.PROOF, 'different')]:
            with self.subTest(marker=marker, timestamp=timestamp):
                self.api = Database()
                self.api.db.execute('UPDATE workspaces SET runtime_deletion_proof=?,runtime_deletion_confirmed_at=? '
                                    'WHERE id=?', [marker, timestamp, proof.WORKSPACE])
                with self.assertRaises(Refused):
                    self.run_transfer()
                self.assertEqual(self.api.updates, 0)

    def test_atomic_recheck_blocks_node_workspace_task_and_usage_races(self):
        scenarios = ["UPDATE nodes SET runtime_incarnation_id='replacement'",
                     "UPDATE nodes SET runtime_termination_confirmed_at='2026-09-08T13:40:00Z'",
                     "UPDATE nodes SET status='running'", "UPDATE nodes SET provider_instance_id='other'",
                     "UPDATE tasks SET status='in_progress'",
                     "UPDATE workspaces SET metadata='changed'",
                     f"UPDATE workspaces SET node_id='{proof.NODE}' WHERE id='{proof.WORKSPACE}'",
                     f"INSERT INTO compute_usage VALUES('{proof.WORKSPACE}')",
                     f"INSERT INTO session_snapshots VALUES(NULL,'{proof.SESSION}')",
                     f"UPDATE workspaces SET node_id='{proof.NODE}',status='running' WHERE id='sentinel'"]
        for sql in scenarios:
            with self.subTest(sql=sql):
                self.api = Database()
                self.api.before_update = lambda db, statement=sql: db.execute(statement)
                with self.assertRaisesRegex(Refused, 'CAS'):
                    self.run_transfer()
                self.assertEqual(self.api.db.execute('SELECT COUNT(*) FROM workspaces '
                                                    'WHERE runtime_deletion_proof IS NOT NULL').fetchone()[0], 0)

    def test_post_write_detects_concurrent_node_change(self):
        self.api.after_update = lambda db: db.execute("UPDATE nodes SET metadata='changed'")
        with self.assertRaisesRegex(Refused, 'Post-transfer node'):
            self.run_transfer()
        self.assertEqual(self.api.updates, 1)

    def test_missing_pin_old_deployment_wrong_account_and_installation_refuse(self):
        with patch.object(proof, 'REQUIRED_VERSION', None):
            with self.assertRaisesRegex(Refused, 'not been pinned'):
                self.run_transfer(False)
        for attribute, value in [('version', 'db06843dd72812ed4f6b7e12a882363901ba1a9d'),
                                 ('base', 'https://api.cloudflare.com/client/v4/accounts/' + '0' * 32),
                                 ('installation', '0' * 32)]:
            with self.subTest(attribute=attribute):
                self.api = Database()
                setattr(self.api, attribute, value)
                with self.assertRaises(Refused):
                    self.run_transfer(False)
                self.assertEqual(self.api.updates, 0)

    def test_domain_and_database_binding_mismatch_refuse(self):
        with self.assertRaises(Refused):
            proof.transfer_proof(self.api, 'other.example', False)
        for binding, field, value in [('BASE_DOMAIN', 'text', 'other.example'),
                                      ('DATABASE', 'id', 'other-database'),
                                      ('DATABASE', 'type', 'kv_namespace')]:
            with self.subTest(binding=binding, field=field):
                self.api = Database()
                settings = self.api.call('/workers/scripts/' + proof.WORKER + '/settings')
                next(row for row in settings['bindings'] if row['name'] == binding)[field] = value
                with patch.object(self.api, 'call', return_value=settings):
                    with self.assertRaises(Refused):
                        self.run_transfer(False)
                self.assertEqual(self.api.updates, 0)


if __name__ == '__main__':
    unittest.main()
