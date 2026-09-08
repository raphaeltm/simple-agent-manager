"""Copy strict termination proof to one audited, never-attached helper placeholder.

Incident identity comes from inventory run 34234712307 and the reviewed metadata
adoption. NULL node/provider fields and timeout text never establish absence.
The normal node stop API must first terminate this exact provider incarnation.
"""
import json
import os
import re
import sys

from repair import Cloudflare, DATABASE, DOMAIN, PROJECT, USER, WORKER, Refused, require

# Reviewed final production commit; no environment override/default-to-current.
REQUIRED_VERSION = 'f5233aa09bdf69f1180f19de20948092321937a7'
ACCOUNT = 'c4e4aebd980b626f6af43ac6b1edcede'
INSTALLATION = '395954c4f369d642341d757537b83c44'
WORKSPACE = '01M20KQE0J0YF60VCAAE8J9VGY'
TASK = '01M20KQE6AM5N3CP4Z4H3Y1HBP'
SESSION = '81c601af-3fc4-4886-b006-c585be20f1be'
NODE = '01M20KQDHX8M3YP89Q6QTQP6S1'
INCARNATION = '43ad0f49-94e5-44b2-9191-1fc40cab281f'
PROVIDER = '165154322'
CREATED = '2026-09-08T13:35:30.065Z'
NODE_CREATED = '2026-09-08T13:36:09.277Z'
PROVIDER_CREATED = '2026-09-08T13:37:19.000Z'
FINGERPRINT = 'sha256:570ce92f77ef15d593bced4b529c17d663586a3e8ecf003bef57f3c4dd3464fc'
CREDENTIAL = 'platform_credentials:01KNY6DC06C9QCYQM0389NAGNT'
WORKSPACE_ERROR = 'Provisioning timed out after 30 minutes'
TASK_ERROR = 'Task runtime is conclusively gone after reconciliation grace (workspace_error).'
PROOF = 'node_runtime_terminated'

NODE_GUARDS = """n.id=? AND n.user_id=? AND n.runtime_incarnation_id=?
 AND n.provider_instance_id=? AND n.created_at=? AND n.status='deleted'
 AND n.runtime='vm' AND n.node_class='managed' AND n.node_role='workspace'
 AND n.cloud_provider='hetzner' AND n.provider_instance_type='cx23' AND n.vm_location='nbg1'
 AND n.credential_source='platform' AND n.placement_credential_reference=?
 AND n.placement_credential_fingerprint=?
 AND julianday(n.runtime_termination_confirmed_at)>=julianday(?)
 AND julianday(n.runtime_termination_confirmed_at)<=julianday('now')
 AND NOT EXISTS(SELECT 1 FROM workspaces other WHERE other.node_id=n.id
   AND other.status NOT IN ('stopped','deleted') AND other.runtime_deletion_confirmed_at IS NULL)
"""
NODE_PARAMS = [NODE, USER, INCARNATION, PROVIDER, NODE_CREATED, CREDENTIAL, FINGERPRINT, PROVIDER_CREATED]
GUARDS = """w.id=? AND w.user_id=? AND w.project_id=? AND w.chat_session_id=?
 AND w.created_at=? AND w.status='error' AND w.error_message=? AND w.node_id IS NULL
 AND w.hetzner_server_id IS NULL AND w.vm_ip IS NULL
 AND NOT EXISTS(SELECT 1 FROM compute_usage u WHERE u.workspace_id=w.id)
 AND NOT EXISTS(SELECT 1 FROM session_snapshots s
   WHERE s.workspace_id=w.id OR s.chat_session_id=w.chat_session_id)
 AND EXISTS(SELECT 1 FROM tasks t WHERE t.id=? AND t.user_id=w.user_id
   AND t.project_id=w.project_id AND t.workspace_id=w.id AND t.chat_session_id=w.chat_session_id
   AND t.created_at=w.created_at AND t.status='failed' AND t.error_message=?
   AND t.execution_step IS NULL AND t.auto_provisioned_node_id IS NULL
   AND t.task_mode='conversation' AND t.triggered_by='user')
 AND EXISTS(SELECT 1 FROM nodes n WHERE """ + NODE_GUARDS + ')'
PARAMS = [WORKSPACE, USER, PROJECT, SESSION, CREATED, WORKSPACE_ERROR, TASK, TASK_ERROR] + NODE_PARAMS
SELECT = 'SELECT w.* FROM workspaces w WHERE ' + GUARDS
NODE_SELECT = 'SELECT n.* FROM nodes n WHERE ' + NODE_GUARDS


def verify_environment(api, domain):
    require(isinstance(REQUIRED_VERSION, str) and bool(re.fullmatch(r'[a-f0-9]{40}', REQUIRED_VERSION)),
            'Reviewed final deployment version has not been pinned')
    require(api.base == 'https://api.cloudflare.com/client/v4/accounts/' + ACCOUNT,
            'Exact staging account mismatch')
    require(domain == DOMAIN, 'GitHub staging BASE_DOMAIN mismatch')
    settings = api.call('/workers/scripts/' + WORKER + '/settings')
    bindings = {binding['name']: binding for binding in settings.get('bindings', [])}
    require(bindings.get('BASE_DOMAIN', {}).get('text') == DOMAIN
            and bindings.get('DATABASE', {}).get('id') == DATABASE
            and bindings.get('DATABASE', {}).get('type') == 'd1'
            and bindings.get('SAM_INSTALLATION_ID', {}).get('text') == INSTALLATION
            and bindings.get('VM_AGENT_REQUIRED_VERSION', {}).get('text') == REQUIRED_VERSION,
            'Exact staging Worker installation/database/version mismatch')


def read_one(api, sql, params):
    rows = api.query(sql, params)['results']
    require(len(rows) == 1, 'Exact terminated node and unattached workspace/task guards did not match')
    return rows[0]


def transfer_proof(api, domain, apply=False):
    verify_environment(api, domain)
    before = read_one(api, SELECT, PARAMS)
    node = read_one(api, NODE_SELECT, NODE_PARAMS)
    timestamp = node['runtime_termination_confirmed_at']
    marker = before['runtime_deletion_proof']
    confirmed = before['runtime_deletion_confirmed_at']
    audit = {'workspace_id': WORKSPACE, 'task_id': TASK, 'node_id': NODE,
             'incarnation': INCARNATION, 'provider_id': PROVIDER, 'database_id': DATABASE,
             'required_version': REQUIRED_VERSION, 'termination_confirmed_at': timestamp,
             'changes': 0, 'changed_fields': []}
    if marker == PROOF and confirmed == timestamp:
        return {**audit, 'outcome': 'already_proven'}
    require(marker is None and confirmed is None, 'Conflicting or partial workspace proof')
    if not apply:
        return {**audit, 'outcome': 'preview_eligible'}
    keys = list(before)
    require(all(re.fullmatch(r'[a-z_]+', key) for key in keys), 'Unexpected workspace column name')
    # Every mutable guard is repeated in the atomic write. The complete workspace
    # snapshot additionally rejects attachment, owner, status and metadata races.
    update = """UPDATE workspaces AS w SET runtime_deletion_proof=?,
      runtime_deletion_confirmed_at=? WHERE """ + GUARDS + ' AND ' + ' AND '.join(
        'w.' + key + ' IS ?' for key in keys) + """
      AND EXISTS(SELECT 1 FROM nodes exact WHERE exact.id=?
        AND exact.runtime_termination_confirmed_at=?)"""
    params = [PROOF, timestamp] + PARAMS + [before[key] for key in keys] + [NODE, timestamp]
    require(len(params) <= 100, 'D1 parameter bound exceeded')
    verify_environment(api, domain)
    result = api.query(update, params)
    require(result.get('meta', {}).get('changes') == 1,
            'Proof transfer CAS did not change exactly one row; inspect before retrying')
    expected = {**before, 'runtime_deletion_proof': PROOF, 'runtime_deletion_confirmed_at': timestamp}
    require(read_one(api, SELECT, PARAMS) == expected,
            'Post-transfer workspace changed; inspect before retrying')
    require(read_one(api, NODE_SELECT, NODE_PARAMS) == node,
            'Post-transfer node changed; inspect before retrying')
    return {**audit, 'outcome': 'proof_transferred', 'changes': 1,
            'changed_fields': ['runtime_deletion_proof', 'runtime_deletion_confirmed_at']}


def main():
    try:
        apply = os.environ.get('APPLY_REPAIR', 'false')
        require(apply in ('true', 'false'), 'APPLY_REPAIR must be true or false')
        api = Cloudflare(os.environ.get('CF_ACCOUNT_ID', ''), os.environ.get('CF_API_TOKEN', ''))
        audit = transfer_proof(api, os.environ.get('BASE_DOMAIN'), apply == 'true')
        serialized = json.dumps(audit, indent=2)
        print(serialized)
        if os.environ.get('GITHUB_STEP_SUMMARY'):
            with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
                summary.write('## Exact helper workspace termination proof\n\n```json\n'
                              + serialized + '\n```\n')
    except Refused as error:
        print('Helper workspace proof refused: ' + str(error), file=sys.stderr)
        return 1
    except Exception:
        print('Helper workspace proof failed; inspect state before an explicit retry.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
