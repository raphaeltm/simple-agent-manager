"""Restore absence proof for three exact, independently audited pre-claim nodes.

The decisive observation is retained insertion credential_source='user' with
planned platform credentials and NULL credential fingerprint. provisionNode
must atomically change these fields and rotate incarnation before createVM;
its failure path never resets them. Error text/null provider ID alone is not proof.
"""
import datetime
import json
import os
import sys
from pathlib import Path

import rearm
from repair import Cloudflare, DATABASE, DOMAIN, PROJECT, USER, Refused, require

COMMON_FIELDS = '''user_id runtime node_class node_role cloud_provider provider_instance_type
provider_instance_id ip_address last_heartbeat_at agent_ready_at backend_dns_record_id
error_message credential_source credential_attribution_source credential_attribution_user_id
credential_attribution_project_id placement_credential_source placement_credential_reference
placement_credential_version placement_credential_fingerprint capacity_pool_id capacity_pool_scope
capacity_pool_revision capacity_pool_candidate_id capacity_pool_project_id vm_location'''.split()
CREATED = [
    '2026-09-08T12:31:57.971Z', '2026-09-08T12:32:43.798Z', '2026-09-08T12:33:12.888Z',
]
CTE = '''WITH exact_nodes(task_id,node_id,incarnation,created_at) AS (
  VALUES (?,?,?,?),(?,?,?,?),(?,?,?,?)
), eligible AS (
  SELECT n.id FROM exact_nodes exact JOIN nodes n ON n.id=exact.node_id
  JOIN tasks t ON t.id=exact.task_id AND t.auto_provisioned_node_id=n.id
  WHERE n.runtime_incarnation_id=exact.incarnation AND n.created_at=exact.created_at
    AND n.status='destroying'
    AND t.user_id=n.user_id AND t.project_id=? AND t.triggered_by='session-recovery'
    AND t.recovery_source_task_id=? AND t.status='failed' AND t.error_message=?
    AND t.workspace_id IS NULL AND t.chat_session_id IS NULL AND t.execution_step IS NULL
    AND t.claimed_warm_node_id IS NULL AND t.claimed_warm_node_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM workspaces w WHERE w.node_id=n.id)
    AND NOT EXISTS(SELECT 1 FROM compute_usage u WHERE u.node_id=n.id)
    AND NOT EXISTS(SELECT 1 FROM session_snapshots s WHERE s.node_id=n.id)
    AND NOT EXISTS(SELECT 1 FROM tasks other WHERE other.id!=t.id
      AND (other.auto_provisioned_node_id=n.id OR other.claimed_warm_node_id=n.id))
    AND '''


def sql_and_params(evidence):
    rows = evidence['nodes']
    require(len(rows) == 3, 'Expected exactly three original node records')
    common = rows[0]
    anchors = {
        'user_id': USER, 'runtime': 'vm', 'node_class': 'managed', 'node_role': 'workspace',
        'cloud_provider': 'hetzner', 'provider_instance_type': 'cx43', 'vm_location': 'nbg1',
        'credential_source': 'user', 'placement_credential_source': 'platform',
        'credential_attribution_source': 'platform', 'credential_attribution_user_id': USER,
        'credential_attribution_project_id': None, 'placement_credential_fingerprint': None,
        'provider_instance_id': None, 'ip_address': None, 'last_heartbeat_at': None,
        'agent_ready_at': None, 'backend_dns_record_id': None,
        'error_message': '[hetzner] ' + rearm.ERROR,
        'capacity_pool_id': 'cap-pool-default:installation', 'capacity_pool_scope': 'installation',
        'capacity_pool_revision': 14, 'capacity_pool_project_id': None,
        'placement_credential_reference': 'platform_credentials:01KNY6DC06C9QCYQM0389NAGNT',
        'placement_credential_version': 1775908597766,
        'capacity_pool_candidate_id': 'cap-candidate-default:cap-pool-default:installation:'
            'cap-source-default:platform:01KNY6DC06C9QCYQM0389NAGNT:hetzner:nbg1:cx43',
    }
    require(all(common.get(k) == v for k, v in anchors.items()), 'Original pre-claim identity mismatch')
    params = []
    for (task, node, incarnation), created in zip(rearm.ATTEMPTS, CREATED):
        original = next((r for r in rows if r['id'] == node), {})
        require(original.get('runtime_incarnation_id') == incarnation
                and original.get('created_at') == created and original.get('status') == 'destroying'
                and original.get('runtime_termination_confirmed_at') is None
                and all(original.get(k) == common[k] for k in COMMON_FIELDS),
                'Original node evidence mismatch')
        params += [task, node, incarnation, created]
    params += [PROJECT, rearm.SOURCE_TASK, rearm.ERROR]
    params += [common[k] for k in COMMON_FIELDS]
    cte = CTE + ' AND '.join('n.' + field + ' IS ?' for field in COMMON_FIELDS) + ') '
    require(len(params) + 2 <= 100, 'D1 binding limit exceeded')
    return cte, params


def repair_nodes(api, domain, evidence, apply=False):
    rearm.verify_environment(api, domain)
    cte, params = sql_and_params(evidence)
    # Explicit projection stays below the D1 result-column limit; no nodes.*.
    columns = ['id', 'status', 'runtime_incarnation_id', 'created_at', 'updated_at',
               'runtime_termination_confirmed_at'] + COMMON_FIELDS
    select = cte + 'SELECT ' + ','.join(columns) + ' FROM nodes WHERE id IN (SELECT id FROM eligible) ORDER BY id'
    before = api.query(select, params)['results']
    require(len(before) == 3, 'The three exact pre-claim node/task/no-runtime guards did not match')
    markers = [row['runtime_termination_confirmed_at'] for row in before]
    audit = {
        'database_id': DATABASE, 'base_domain': DOMAIN, 'worker': rearm.WORKER,
        'required_version': rearm.REQUIRED_VERSION, 'node_ids': [row['id'] for row in before],
        'incarnations': [row['runtime_incarnation_id'] for row in before],
        'changes': 0, 'before_proof_timestamps': markers,
        'reason': 'Restore absence proof for exact retained pre-provider-claim node incarnations',
    }
    if all(isinstance(marker, str) and marker for marker in markers):
        audit.update(outcome='already_proven', after_proof_timestamps=markers)
        return audit
    require(all(marker is None for marker in markers), 'Partial node proof state requires review')
    if not apply:
        audit.update(outcome='preview_eligible', after_proof_timestamps=markers)
        return audit
    rearm.verify_environment(api, domain)
    at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    # Materialize all-null eligible membership before any row changes: all three
    # must still match, or the single atomic statement changes zero rows.
    update = cte + ''', unproven AS MATERIALIZED (
      SELECT id FROM nodes WHERE id IN (SELECT id FROM eligible)
        AND runtime_termination_confirmed_at IS NULL
    ) UPDATE nodes SET runtime_termination_confirmed_at=?,updated_at=?
      WHERE id IN (SELECT id FROM unproven) AND (SELECT COUNT(*) FROM unproven)=3'''
    result = api.query(update, params + [at, at])
    require(result.get('meta', {}).get('changes') == 3,
            'Guarded node proof update did not change exactly three rows; inspect before retrying')
    after = api.query(select, params)['results']
    require(after == [{**row, 'runtime_termination_confirmed_at': at, 'updated_at': at} for row in before],
            'Node proof post-write verification failed; inspect before retrying')
    audit.update(outcome='node_proofs_persisted', changes=3, after_proof_timestamps=[at] * 3)
    return audit


def main():
    try:
        apply_value = os.environ.get('APPLY_REPAIR', 'false')
        require(apply_value in ('true', 'false'), 'APPLY_REPAIR must be true or false')
        evidence = json.loads(Path(__file__).with_name('node-proof-evidence.json').read_text())
        api = Cloudflare(os.environ.get('CF_ACCOUNT_ID', ''), os.environ.get('CF_API_TOKEN', ''))
        audit = repair_nodes(api, os.environ.get('BASE_DOMAIN'), evidence, apply_value == 'true')
        serialized = json.dumps(audit, indent=2)
        print(serialized)
        if os.environ.get('GITHUB_STEP_SUMMARY'):
            with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
                summary.write('## PR 2030 exact pre-claim node proofs\n\n```json\n' + serialized + '\n```\n')
    except Refused as error:
        print('Node proof repair refused: ' + str(error), file=sys.stderr)
        return 1
    except Exception:
        print('Node proof repair failed unexpectedly; inspect state before an explicit retry.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
