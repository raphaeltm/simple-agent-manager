"""One-off, identity-fenced staging repair. No runtime deletion or deployment.

The original provider-412 observation predates proof persistence. This script
only restores that missing proof; the normal authenticated DELETE API must
subsequently perform workspace deletion. Never generalize this inference to
other null-node workspaces. See README.md for provenance and operator steps.
"""
import datetime
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

DOMAIN = 'sammy.party'
DATABASE = '1cfaf5d4-8226-47d8-bf26-6ba727ce5718'
WORKER = 'sam-api-staging'
VERSION = '708e4f179aab3d9ee66c8f0dfe5e73eb5c856eb1'
WORKSPACE = '01M20BZ3SP1ME6HDS6R4WTA6SB'
TASK = '01M20BZ3YM6VA2B6NH82P65B21'
PROJECT = '01M201HEKK895BY9Q7TYSJA4WY'
USER = 'OpyarsKMu4aZYJdlPpfQj73bRrjh8q1N'
SESSION = '9fa25a37-69e6-4efa-97e4-55b770d7d5c4'
ERROR = '[hetzner] hetzner API error (412): error during placement'
PROOF = 'workspace_never_started'
IDENTITY = [WORKSPACE, USER, PROJECT, SESSION]

# Repeat every mutable guard in the UPDATE: the preview read is not a lock.
GUARDS = """
  id=? AND user_id=? AND project_id=? AND chat_session_id=?
  AND status='stopping' AND node_id IS NULL
  AND hetzner_server_id IS NULL AND vm_ip IS NULL
  AND NOT EXISTS(SELECT 1 FROM compute_usage WHERE workspace_id=workspaces.id)
  AND NOT EXISTS(SELECT 1 FROM session_snapshots
    WHERE workspace_id=workspaces.id OR chat_session_id=workspaces.chat_session_id)
  AND EXISTS(SELECT 1 FROM tasks t WHERE t.id=?
    AND t.workspace_id=workspaces.id AND t.user_id=workspaces.user_id
    AND t.project_id=workspaces.project_id AND t.chat_session_id=workspaces.chat_session_id
    AND t.status='failed' AND t.execution_step='workspace_creation'
    AND t.auto_provisioned_node_id IS NULL AND t.error_message=?)
"""
PARAMS = IDENTITY + [TASK, ERROR]
SELECT = """SELECT id,user_id,project_id,chat_session_id,node_id,status,
  hetzner_server_id,vm_ip,runtime_deletion_proof,runtime_deletion_confirmed_at
  FROM workspaces WHERE """ + GUARDS
UPDATE = """UPDATE workspaces SET runtime_deletion_confirmed_at=?,
  runtime_deletion_proof='workspace_never_started',updated_at=? WHERE """ + GUARDS + """
  AND runtime_deletion_proof IS NULL AND runtime_deletion_confirmed_at IS NULL
"""


class Refused(Exception):
    """Sanitized operator-facing rejection; never include API bodies or secrets."""


def require(condition, message):
    if not condition:
        raise Refused(message)


class Cloudflare:
    def __init__(self, account, token):
        require(bool(re.fullmatch(r'[0-9a-f]{32}', account)), 'Invalid account configuration')
        require(bool(token), 'Missing Cloudflare credential')
        self.base = 'https://api.cloudflare.com/client/v4/accounts/' + account
        self.token = token

    def call(self, path, payload=None):
        request = urllib.request.Request(
            self.base + path,
            data=None if payload is None else json.dumps(payload).encode(),
            headers={'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json'},
        )
        # Never retry an UPDATE after an ambiguous network response. A subsequent
        # explicit run verifies the retained proof and becomes a read-only no-op.
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                result = json.load(response)
        except urllib.error.HTTPError as error:
            raise Refused(f'Cloudflare request failed with HTTP {error.code}') from None
        except (OSError, ValueError):
            raise Refused('Cloudflare request failed; inspect state before retrying') from None
        require(result.get('success') is True, 'Cloudflare API rejected request')
        return result['result']

    def query(self, sql, params):
        result = self.call('/d1/database/' + DATABASE + '/query', {'sql': sql, 'params': params})
        require(len(result) == 1 and result[0].get('success') is True, 'D1 query failed')
        return result[0]


def verify_environment(api, domain):
    require(domain == DOMAIN, 'GitHub staging BASE_DOMAIN mismatch')
    settings = api.call('/workers/scripts/' + WORKER + '/settings')
    bindings = {binding['name']: binding for binding in settings.get('bindings', [])}
    require(bindings.get('BASE_DOMAIN', {}).get('text') == DOMAIN, 'Worker BASE_DOMAIN mismatch')
    require(bindings.get('DATABASE', {}).get('id') == DATABASE, 'Worker DATABASE mismatch')
    require(bindings.get('DATABASE', {}).get('type') == 'd1', 'Worker DATABASE binding type mismatch')
    require(bindings.get('VM_AGENT_REQUIRED_VERSION', {}).get('text') == VERSION,
            'Corrected Worker version is not live')


def verify_original(evidence):
    require(evidence.get('observed_at') == '2026-09-08T11:21:00.349222+00:00',
            'Original observation timestamp mismatch')
    require(evidence.get('workspace') == {
        'id': WORKSPACE, 'status': 'error', 'node_id': None,
        'chat_session_id': SESSION, 'error_message': ERROR,
        'runtime_deletion_confirmed_at': None,
    }, 'Original failed workspace evidence mismatch')
    require(evidence.get('task') == {
        'id': TASK, 'workspace_id': WORKSPACE, 'chat_session_id': SESSION,
        'status': 'failed', 'execution_step': 'workspace_creation',
        'auto_provisioned_node_id': None, 'error_message': ERROR,
    }, 'Original provider failure evidence mismatch')
    require(evidence.get('nodes') == [] and evidence.get('snapshots') == [],
            'Original observation has runtime or snapshot evidence')


def read_placeholder(api):
    rows = api.query(SELECT, PARAMS)['results']
    require(len(rows) == 1, 'Exact stopping placeholder and cleanup guards did not match')
    return rows[0]


def repair(api, domain, evidence, apply=False):
    verify_original(evidence)
    verify_environment(api, domain)
    before = read_placeholder(api)
    marker = before['runtime_deletion_proof']
    timestamp = before['runtime_deletion_confirmed_at']
    audit = {
        'workspace_id': WORKSPACE, 'task_id': TASK, 'database_id': DATABASE,
        'worker': WORKER, 'required_version': VERSION, 'base_domain': DOMAIN,
        'reason': 'Restore missing proof for the observed pre-attachment provider 412 failure',
        'before': before, 'changes': 0,
    }
    if marker == PROOF and isinstance(timestamp, str) and timestamp:
        audit.update(outcome='already_proven', after=before)
        return audit
    require(marker is None and timestamp is None, 'Ambiguous or conflicting cleanup proof')
    if not apply:
        audit.update(outcome='preview_eligible', after=before)
        return audit
    # Revalidate deployment immediately before mutation; workflow concurrency
    # serializes this job against the existing staging deployment workflow.
    verify_environment(api, domain)
    at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    result = api.query(UPDATE, [at, at] + PARAMS)
    require(result.get('meta', {}).get('changes') == 1,
            'Guarded UPDATE did not change exactly one row; inspect state before retrying')
    after = read_placeholder(api)
    require(after == {**before, 'runtime_deletion_proof': PROOF,
                      'runtime_deletion_confirmed_at': at}, 'Post-write proof verification failed')
    audit.update(outcome='proof_persisted', changes=1, after=after)
    return audit


def main():
    try:
        apply_value = os.environ.get('APPLY_REPAIR', 'false')
        require(apply_value in ('true', 'false'), 'APPLY_REPAIR must be true or false')
        evidence = json.loads(Path(__file__).with_name('original-evidence.json').read_text())
        api = Cloudflare(os.environ.get('CF_ACCOUNT_ID', ''), os.environ.get('CF_API_TOKEN', ''))
        audit = repair(api, os.environ.get('BASE_DOMAIN'), evidence, apply_value == 'true')
        serialized = json.dumps(audit, indent=2)
        print(serialized)
        if os.environ.get('GITHUB_STEP_SUMMARY'):
            with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
                summary.write('## PR 2030 staging placeholder cleanup\n\n```json\n' + serialized + '\n```\n')
    except Refused as error:
        print('Repair refused: ' + str(error), file=sys.stderr)
        return 1
    except Exception:
        # No traceback: HTTP objects and environment-derived values stay private.
        print('Repair failed unexpectedly; no automatic retry. Inspect state before rerunning.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
