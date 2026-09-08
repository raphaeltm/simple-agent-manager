"""One exact snapshot rearm after audited provider rejection, gated on ready compute."""
import hashlib
import json
import os
import sys
from pathlib import Path

import rearm
from repair import Cloudflare, DATABASE, DOMAIN, PROJECT, USER, WORKER, Refused, require

REQUIRED_VERSION = 'db06843dd72812ed4f6b7e12a882363901ba1a9d'
# The reviewed evidence must pin a successfully provisioned helper before preview/apply.
HELPER_FIELDS = ['workspace_id', 'id', 'runtime_incarnation_id', 'provider_instance_id', 'provider_instance_type']
ERROR = 'hetzner API error (412): error during placement'
ATTEMPTS = [
    ('01M20K9HMMC05VBQRVA747Y0XN', '01M20KA5S59N4NNJJK3N897B2C',
     'ac092191-b469-4746-bc2a-26fd43e9e986', '2026-09-08T13:29:02.251Z', '2026-09-08T13:28:55.333Z'),
    ('01M20KA6TXED4ER6B4DPVH54QQ', '01M20KBHS0AKTPKCC1ZTDYQR0D',
     '987cdcc3-3502-452d-a046-2d8a082de0ff', '2026-09-08T13:29:47.128Z', '2026-09-08T13:29:40.384Z'),
    ('01M20KB4B0YRDZ0B5ARAHHJA7H', '01M20KCFECZV8VGM504CAE6VJR',
     'e9bc8b9d-1ae4-4ce0-81ee-8895558cdc24', '2026-09-08T13:30:17.579Z', '2026-09-08T13:30:10.764Z'),
]
CTE = '''WITH exact_attempts(task_id,node_id,incarnation,confirmed_at,created_at)
 AS (VALUES (?,?,?,?,?),(?,?,?,?,?),(?,?,?,?,?)) '''
HELPER_HEALTH = '''
 helper_w.status='running' AND helper_n.status='running'
 AND helper_n.user_id=helper_w.user_id AND helper_n.runtime='vm'
 AND helper_n.node_class='managed' AND helper_n.node_role='workspace'
 AND helper_n.cloud_provider='hetzner' AND helper_n.vm_location='nbg1'
 AND helper_n.health_status='healthy'
 AND helper_n.capacity_pool_id='cap-pool-default:installation'
 AND helper_n.capacity_pool_scope='installation'
 AND helper_n.runtime_termination_confirmed_at IS NULL
 AND helper_n.provider_instance_id IS NOT NULL AND helper_n.provider_instance_id!=''
 AND helper_n.ip_address IS NOT NULL AND helper_n.ip_address!=''
 AND helper_n.runtime_incarnation_id IS NOT NULL AND helper_n.runtime_incarnation_id!=''
 AND helper_n.agent_ready_at IS NOT NULL
 AND helper_n.observed_hardware_source='observed'
 AND helper_n.observed_provider_instance_type=helper_n.provider_instance_type
 AND helper_n.observed_provider_instance_vcpu_count>=2
 AND helper_n.observed_provider_instance_memory_mb>=4096
 AND json_valid(helper_w.resolved_reservation_json)
 AND json_extract(helper_w.resolved_reservation_json,'$.cpuMillis')=250
 AND json_extract(helper_w.resolved_reservation_json,'$.memoryMb')=512
 AND json_extract(helper_w.resolved_reservation_json,'$.maxCoTenants')=3
 AND NOT EXISTS(SELECT 1 FROM workspaces other WHERE other.node_id=helper_n.id
   AND other.id!=helper_w.id AND other.status IN ('running','creating','recovery'))
 AND unixepoch(helper_n.last_heartbeat_at)>=unixepoch()-90
 AND helper_n.agent_version=?
'''
RUNTIME_GUARDS = '''
 AND unixepoch(snapshot.expires_at)>unixepoch()
 AND (SELECT COUNT(*) FROM exact_attempts exact
   JOIN tasks t ON t.id=exact.task_id
   JOIN nodes n ON n.id=exact.node_id AND n.id=t.auto_provisioned_node_id
   WHERE t.user_id=snapshot.user_id AND t.project_id=snapshot.project_id
     AND t.triggered_by='session-recovery' AND t.recovery_source_task_id=?
     AND t.status='failed' AND t.error_message=? AND t.workspace_id IS NULL
     AND t.chat_session_id IS NULL AND t.execution_step IS NULL
     AND t.claimed_warm_node_id IS NULL AND t.claimed_warm_node_at IS NULL
     AND n.user_id=snapshot.user_id AND n.runtime_incarnation_id=exact.incarnation
     AND n.runtime_termination_confirmed_at=exact.confirmed_at AND n.created_at=exact.created_at
     AND n.status IN ('destroying','deleted') AND n.cloud_provider='hetzner'
     AND n.runtime='vm' AND n.node_class='managed' AND n.node_role='workspace'
     AND n.provider_instance_type='cx43' AND n.vm_location='nbg1'
     AND n.error_message=? AND n.provider_instance_id IS NULL AND n.ip_address IS NULL
     AND n.last_heartbeat_at IS NULL AND n.agent_ready_at IS NULL AND n.backend_dns_record_id IS NULL
     AND NOT EXISTS(SELECT 1 FROM workspaces w WHERE w.node_id=n.id)
     AND NOT EXISTS(SELECT 1 FROM compute_usage u WHERE u.node_id=n.id)
     AND NOT EXISTS(SELECT 1 FROM session_snapshots s WHERE s.node_id=n.id)
     AND NOT EXISTS(SELECT 1 FROM tasks other WHERE other.id!=t.id
       AND (other.auto_provisioned_node_id=n.id OR other.claimed_warm_node_id=n.id))
 )=3
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
    require(domain == DOMAIN, 'GitHub staging BASE_DOMAIN mismatch')
    bindings = {b['name']: b for b in api.call('/workers/scripts/' + WORKER + '/settings').get('bindings', [])}
    require(bindings.get('BASE_DOMAIN', {}).get('text') == DOMAIN, 'Worker BASE_DOMAIN mismatch')
    require(bindings.get('DATABASE', {}).get('type') == 'd1'
            and bindings.get('DATABASE', {}).get('id') == DATABASE, 'Worker DATABASE mismatch')
    require(bindings.get('VM_AGENT_REQUIRED_VERSION', {}).get('text') == REQUIRED_VERSION,
            'Reviewed recovery Worker version is not live')


def helper_binding(api, evidence):
    expected = evidence.get('helper')
    require(isinstance(expected, dict) and set(expected) == set(HELPER_FIELDS)
            and all(isinstance(expected[field], str) and expected[field] for field in HELPER_FIELDS),
            'A healthy exact helper has not yet been captured and reviewed')
    rows = api.query('''SELECT helper_w.id AS workspace_id,helper_n.id,helper_n.runtime_incarnation_id,
        helper_n.provider_instance_id,helper_n.provider_instance_type
      FROM workspaces helper_w JOIN nodes helper_n ON helper_n.id=helper_w.node_id
      WHERE helper_w.id=? AND helper_w.user_id=? AND helper_w.project_id=? AND ''' + HELPER_HEALTH,
      [expected['workspace_id'], USER, PROJECT, REQUIRED_VERSION])['results']
    require(rows == [expected], 'Exact helper identity/health/capacity no longer matches reviewed evidence')
    return expected


def read_original_evidence():
    return json.loads(Path(__file__).with_name('recovery-evidence.json').read_text())


def sql_and_params(evidence, helper):
    original = read_original_evidence()
    expected = {**original['snapshot'], 'recovery_task_id': ATTEMPTS[-1][0],
                'recovery_error': ERROR, 'updated_at': '2026-09-08T13:30:19.349Z'}
    require(evidence['snapshot'] == expected, 'Original preserved snapshot evidence mismatch')
    require(evidence['manifest_json_sha256'] == original['manifest_json_sha256'],
            'Original manifest digest mismatch')
    require(len(evidence['tasks']) == 3 and len(evidence['nodes']) == 3, 'Incomplete failed attempt evidence')
    for task_id, node_id, incarnation, proof, created in ATTEMPTS:
        task = next((t for t in evidence['tasks'] if t['id'] == task_id), {})
        node = next((n for n in evidence['nodes'] if n['id'] == node_id), {})
        require(all(task.get(k) == v for k, v in {
            'user_id': USER, 'project_id': PROJECT, 'status': 'failed', 'error_message': ERROR,
            'workspace_id': None, 'chat_session_id': None, 'auto_provisioned_node_id': node_id,
            'recovery_source_task_id': rearm.SOURCE_TASK, 'triggered_by': 'session-recovery',
        }.items()), 'Original failed provider task evidence mismatch')
        require(all(node.get(k) == v for k, v in {
            'user_id': USER, 'runtime_incarnation_id': incarnation, 'created_at': created,
            'runtime_termination_confirmed_at': proof, 'status': 'destroying',
            'provider_instance_id': None, 'ip_address': None, 'error_message': '[hetzner] ' + ERROR,
        }.items()), 'Original positive absence-proof evidence mismatch')
    snapshot = evidence['snapshot']
    guards = ' AND '.join('snapshot.' + field + ' IS ?' for field in rearm.SNAPSHOT_FIELDS)
    params = [value for attempt in ATTEMPTS for value in attempt]
    params += [snapshot[field] for field in rearm.SNAPSHOT_FIELDS]
    params += [rearm.SOURCE_TASK, ERROR, '[hetzner] ' + ERROR, rearm.SOURCE_TASK]
    guards += RUNTIME_GUARDS + ''' AND EXISTS(
      SELECT 1 FROM workspaces helper_w JOIN nodes helper_n ON helper_n.id=helper_w.node_id
      WHERE helper_w.id=? AND helper_w.user_id=snapshot.user_id AND helper_w.project_id=snapshot.project_id
        AND helper_n.id=? AND helper_n.runtime_incarnation_id=? AND helper_n.provider_instance_id=?
        AND helper_n.provider_instance_type=?
        AND ''' + HELPER_HEALTH + ')'
    params += [helper['workspace_id'], helper['id'], helper['runtime_incarnation_id'],
               helper['provider_instance_id'], helper['provider_instance_type'], REQUIRED_VERSION]
    require(len(params) + 1 <= 100, 'D1 binding limit exceeded')
    return guards, params


def retry(api, domain, evidence, apply=False):
    verify_environment(api, domain)
    helper = helper_binding(api, evidence)
    guards, params = sql_and_params(evidence, helper)
    select = CTE + 'SELECT snapshot.* FROM session_snapshots snapshot WHERE ' + guards
    rows = api.query(select, params)['results']
    require(len(rows) == 1, 'Exact snapshot, proof, failed attempt, or helper guards did not match')
    before = rows[0]
    require(isinstance(before.get('manifest_json'), str)
            and hashlib.sha256(before['manifest_json'].encode()).hexdigest()
            == evidence['manifest_json_sha256'], 'Preserved manifest hash mismatch')
    require(before['recovery_attempts'] in (0, 3), 'Unexpected recovery attempt count')
    audit = {
        'operation': 'retry-provider-recovery', 'snapshot_id': rearm.SNAPSHOT,
        'chat_session_id': rearm.SESSION, 'database_id': DATABASE, 'base_domain': DOMAIN,
        'required_version': REQUIRED_VERSION, 'helper_workspace_id': helper['workspace_id'],
        'helper_node_id': helper['id'], 'helper_incarnation': helper['runtime_incarnation_id'],
        'failed_task_ids': [a[0] for a in ATTEMPTS], 'proof_timestamps': [a[3] for a in ATTEMPTS],
        'snapshot_generation': rearm.GENERATION, 'home_sha256': rearm.HOME_HASH, 'wip_sha256': rearm.WIP_HASH,
        'changes': 0, 'before_attempts': before['recovery_attempts'],
        'after_attempts': before['recovery_attempts'],
    }
    if before['recovery_attempts'] == 0:
        return {**audit, 'outcome': 'already_rearmed'}
    if not apply:
        return {**audit, 'outcome': 'preview_eligible'}
    verify_environment(api, domain)
    result = api.query(CTE + 'UPDATE session_snapshots AS snapshot SET recovery_attempts=0 WHERE '
                       + guards + ' AND snapshot.recovery_attempts=3 AND snapshot.manifest_json IS ?',
                       params + [before['manifest_json']])
    require(result.get('meta', {}).get('changes') == 1, 'Atomic retry changed zero rows; inspect before retrying')
    after = api.query(select, params)['results']
    require(after == [{**before, 'recovery_attempts': 0}], 'Post-write state changed unexpectedly; inspect before retrying')
    return {**audit, 'outcome': 'provider_recovery_rearmed', 'changes': 1, 'after_attempts': 0}


def main():
    try:
        apply = os.environ.get('APPLY_REPAIR', 'false')
        require(apply in ('true', 'false'), 'APPLY_REPAIR must be true or false')
        evidence = json.loads(Path(__file__).with_name('provider-recovery-evidence.json').read_text())
        api = Cloudflare(os.environ.get('CF_ACCOUNT_ID', ''), os.environ.get('CF_API_TOKEN', ''))
        audit = retry(api, os.environ.get('BASE_DOMAIN'), evidence, apply == 'true')
        serialized = json.dumps(audit, indent=2)
        print(serialized)
        if os.environ.get('GITHUB_STEP_SUMMARY'):
            with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
                summary.write('## PR 2030 exact provider recovery retry\n\n```json\n' + serialized + '\n```\n')
    except Refused as error:
        print('Provider recovery retry refused: ' + str(error), file=sys.stderr)
        return 1
    except Exception:
        print('Provider recovery retry failed unexpectedly; inspect before retrying.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
