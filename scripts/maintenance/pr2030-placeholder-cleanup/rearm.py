"""Rearm only one audited staging snapshot after three pre-provider failures.

No artifact, lifecycle status, timestamp, task, node, or runtime proof is changed.
The fixed corrected Worker SHA must be reviewed and filled in before any run.
"""
import hashlib
import json
import os
import re
import sys
from pathlib import Path

from repair import Cloudflare, DATABASE, DOMAIN, USER, PROJECT, WORKER, VERSION, Refused, require

REQUIRED_VERSION = 'db06843dd72812ed4f6b7e12a882363901ba1a9d'
SNAPSHOT = '01M20CJ25DMR28FAJY2BC330TD'
SESSION = 'ef07c74a-54c5-444a-a2ee-54d4ce21d939'
SOURCE_TASK = '01M20CEC0DFB855QER77A1421P'
GENERATION = '01M20DQDJ01ETA8ZMJYY89HK9M'
HOME_HASH = 'dbb8f33047565ca111d488ce8489b65a852571f735b7f9162d34381a33f00975'
WIP_HASH = '9109bfe8a1c21ce10f0e773e46e8bce461255e150c08306fa97243a6822ea128'
ERROR = 'Node allocation plan is no longer current'
ATTEMPTS = [
    ('01M20G1AHVKVBDDD52VFBKRPSA', '01M20G1WGK1QC4MHS04K35MFYZ', '86cd890f-3421-4149-90e2-99e8a1213f10'),
    ('01M20G1YCKXVS2M2AT72JM4FE5', '01M20G398P7NWRHFVPXYM3JD4N', 'e34ce517-d267-405c-900c-f4b7c8cfce22'),
    ('01M20G2VYM8XWE15W0ZFEBFTJ9', '01M20G45NRG2RV0GB9RXK3CVZS', 'e7e2c061-b387-4c55-b5a3-c2ed680775cc'),
]
# Explicit identifiers avoid executable SQL being sourced from the evidence file.
SNAPSHOT_FIELDS = '''id project_id workspace_id node_id user_id chat_session_id
agent_session_id runtime status degradation home_r2_key wip_r2_key manifest_r2_key
base_commit expires_at restore_status restore_message restored_at created_at updated_at
sleeping_at recovery_status recovery_task_id recovery_workspace_id recovery_error
recovery_claimed_at sleep_status sleep_after sleep_attempts sleep_error sleep_claim_id
sleep_claimed_at snapshot_generation capture_generation home_sha256 wip_sha256
 authorized_home_bytes authorized_home_sha256 authorized_wip_bytes authorized_wip_sha256
 capture_error sleep_stopping_since'''.split()

CTE = 'WITH exact_attempts(task_id,node_id,incarnation) AS (VALUES (?,?,?),(?,?,?),(?,?,?)) '
RUNTIME_GUARDS = '''
 AND unixepoch(snapshot.expires_at) > unixepoch()
 AND (SELECT COUNT(*) FROM exact_attempts exact
   JOIN tasks t ON t.id=exact.task_id
   JOIN nodes n ON n.id=exact.node_id AND n.id=t.auto_provisioned_node_id
   WHERE t.user_id=snapshot.user_id AND t.project_id=snapshot.project_id
     AND t.triggered_by='session-recovery' AND t.recovery_source_task_id=?
     AND t.status='failed' AND t.error_message=? AND t.workspace_id IS NULL
     AND t.chat_session_id IS NULL AND t.execution_step IS NULL
     AND t.claimed_warm_node_id IS NULL AND t.claimed_warm_node_at IS NULL
     AND n.user_id=snapshot.user_id AND n.runtime_incarnation_id=exact.incarnation
     AND n.status IN ('destroying','deleted') AND n.cloud_provider='hetzner'
     AND n.error_message=? AND n.provider_instance_id IS NULL AND n.ip_address IS NULL
     AND n.last_heartbeat_at IS NULL AND n.agent_ready_at IS NULL
     AND n.backend_dns_record_id IS NULL
     AND n.credential_source='user' AND n.placement_credential_source='platform'
     AND n.credential_attribution_source='platform' AND n.placement_credential_fingerprint IS NULL
     AND NOT EXISTS(SELECT 1 FROM workspaces w WHERE w.node_id=n.id AND w.status!='deleted')
     AND NOT EXISTS(SELECT 1 FROM compute_usage u WHERE u.node_id=n.id)
 ) = 3
 AND NOT EXISTS(SELECT 1 FROM tasks active
   WHERE active.user_id=snapshot.user_id AND active.project_id=snapshot.project_id
     AND active.triggered_by='session-recovery'
     AND (active.recovery_source_task_id=? OR active.chat_session_id=snapshot.chat_session_id)
     AND active.status NOT IN ('failed','completed','cancelled'))
 AND NOT EXISTS(SELECT 1 FROM workspaces w
   WHERE w.chat_session_id=snapshot.chat_session_id AND w.status NOT IN ('stopped','deleted'))
 AND NOT EXISTS(SELECT 1 FROM session_snapshots other
   WHERE other.chat_session_id=snapshot.chat_session_id AND other.id!=snapshot.id)
'''


def verify_environment(api, domain):
    require(isinstance(REQUIRED_VERSION, str) and re.fullmatch(r'[0-9a-f]{40}', REQUIRED_VERSION)
            and REQUIRED_VERSION != VERSION, 'New corrected Worker SHA has not been configured')
    require(domain == DOMAIN, 'GitHub staging BASE_DOMAIN mismatch')
    bindings = {b['name']: b for b in api.call('/workers/scripts/' + WORKER + '/settings').get('bindings', [])}
    require(bindings.get('BASE_DOMAIN', {}).get('text') == DOMAIN, 'Worker BASE_DOMAIN mismatch')
    require(bindings.get('DATABASE', {}).get('type') == 'd1'
            and bindings.get('DATABASE', {}).get('id') == DATABASE, 'Worker DATABASE mismatch')
    require(bindings.get('VM_AGENT_REQUIRED_VERSION', {}).get('text') == REQUIRED_VERSION,
            'Corrected recovery Worker version is not live')


def sql_and_params(evidence):
    snapshot = evidence['snapshot']
    anchors = {
        'id': SNAPSHOT, 'chat_session_id': SESSION, 'user_id': USER, 'project_id': PROJECT,
        'status': 'available', 'degradation': 'none', 'recovery_status': 'failed',
        'recovery_task_id': ATTEMPTS[-1][0], 'recovery_attempts': 3,
        'recovery_workspace_id': None, 'recovery_claimed_at': None, 'recovery_error': ERROR,
        'sleep_status': 'sleeping', 'sleeping_at': '2026-09-08T11:51:34.800Z',
        'snapshot_generation': GENERATION, 'home_sha256': HOME_HASH, 'wip_sha256': WIP_HASH,
        'capture_generation': None, 'restored_at': None,
    }
    require(all(snapshot.get(k) == v for k, v in anchors.items()), 'Original snapshot evidence mismatch')
    require(len(evidence['tasks']) == 3 and len(evidence['nodes']) == 3,
            'Original attempt evidence is incomplete')
    for task_id, node_id, incarnation in ATTEMPTS:
        task = next((t for t in evidence['tasks'] if t['id'] == task_id), {})
        node = next((n for n in evidence['nodes'] if n['id'] == node_id), {})
        require(all(task.get(k) == v for k, v in {
            'id': task_id, 'user_id': USER, 'project_id': PROJECT, 'status': 'failed',
            'error_message': ERROR, 'workspace_id': None, 'chat_session_id': None,
            'auto_provisioned_node_id': node_id, 'recovery_source_task_id': SOURCE_TASK,
            'triggered_by': 'session-recovery', 'claimed_warm_node_id': None,
        }.items()), 'Original failed task evidence mismatch')
        require(all(node.get(k) == v for k, v in {
            'id': node_id, 'user_id': USER, 'runtime_incarnation_id': incarnation,
            'status': 'destroying', 'cloud_provider': 'hetzner', 'provider_instance_id': None,
            'ip_address': None, 'last_heartbeat_at': None, 'error_message': '[hetzner] ' + ERROR,
        }.items()), 'Original pre-provider node evidence mismatch')
    predicates = ' AND '.join('snapshot.' + field + ' IS ?' for field in SNAPSHOT_FIELDS)
    params = [value for attempt in ATTEMPTS for value in attempt]
    params += [snapshot[field] for field in SNAPSHOT_FIELDS]
    params += [SOURCE_TASK, ERROR, '[hetzner] ' + ERROR, SOURCE_TASK]
    require(len(params) <= 100, 'D1 binding limit exceeded')
    return predicates + RUNTIME_GUARDS, params


def rearm(api, domain, evidence, apply=False):
    verify_environment(api, domain)
    guards, params = sql_and_params(evidence)
    select = CTE + 'SELECT snapshot.* FROM session_snapshots snapshot WHERE ' + guards
    # Never print manifest_json: it may contain user/session data.
    rows = api.query(select, params)['results']
    require(len(rows) == 1, 'Exact snapshot, failed attempts, or no-active-runtime guards did not match')
    before = rows[0]
    require(isinstance(before.get('manifest_json'), str)
            and hashlib.sha256(before['manifest_json'].encode()).hexdigest()
            == evidence['manifest_json_sha256'], 'Preserved manifest hash mismatch')
    require(before['recovery_attempts'] in (0, 3), 'Unexpected recovery attempt count')
    audit = {
        'snapshot_id': SNAPSHOT, 'chat_session_id': SESSION, 'database_id': DATABASE,
        'worker': WORKER, 'required_version': REQUIRED_VERSION, 'base_domain': DOMAIN,
        'snapshot_generation': GENERATION, 'home_sha256': HOME_HASH, 'wip_sha256': WIP_HASH,
        'failed_task_ids': [a[0] for a in ATTEMPTS], 'changes': 0,
        'before_attempts': before['recovery_attempts'], 'after_attempts': before['recovery_attempts'],
        'recovery_status': before['recovery_status'], 'sleep_status': before['sleep_status'],
        'reason': 'Rearm the same preserved snapshot after three audited pre-provider stale-plan failures',
    }
    if before['recovery_attempts'] == 0:
        audit['outcome'] = 'already_rearmed'
        return audit
    if not apply:
        audit['outcome'] = 'preview_eligible'
        return audit
    verify_environment(api, domain)
    update = CTE + 'UPDATE session_snapshots AS snapshot SET recovery_attempts=0 WHERE ' + guards
    update += ' AND snapshot.recovery_attempts=3 AND snapshot.manifest_json IS ?'
    result = api.query(update, params + [before['manifest_json']])
    require(result.get('meta', {}).get('changes') == 1,
            'Guarded rearm did not change exactly one row; inspect state before retrying')
    after = api.query(select, params)['results']
    require(len(after) == 1 and after[0] == {**before, 'recovery_attempts': 0},
            'Post-write verification failed; inspect state before retrying')
    audit.update(outcome='recovery_rearmed', changes=1, after_attempts=0)
    return audit


def main():
    try:
        apply_value = os.environ.get('APPLY_REPAIR', 'false')
        require(apply_value in ('true', 'false'), 'APPLY_REPAIR must be true or false')
        evidence = json.loads(Path(__file__).with_name('recovery-evidence.json').read_text())
        api = Cloudflare(os.environ.get('CF_ACCOUNT_ID', ''), os.environ.get('CF_API_TOKEN', ''))
        audit = rearm(api, os.environ.get('BASE_DOMAIN'), evidence, apply_value == 'true')
        serialized = json.dumps(audit, indent=2)
        print(serialized)
        if os.environ.get('GITHUB_STEP_SUMMARY'):
            with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
                summary.write('## PR 2030 exact recovery rearm\n\n```json\n' + serialized + '\n```\n')
    except Refused as error:
        print('Rearm refused: ' + str(error), file=sys.stderr)
        return 1
    except Exception:
        print('Rearm failed unexpectedly; inspect state before any explicit retry.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
