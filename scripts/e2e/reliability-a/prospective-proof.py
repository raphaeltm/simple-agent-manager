"""Selected CF_TOKEN+CF_ACCOUNT_ID only. Fixed read-only D1/Worker projection.
Never outputs records/errors/secrets. Config/receipt and canonical API mapping are host-owned.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.request

PROJECT = '01KJNR9R3TEN3KX1ETE33852R8'
VERSION = 'b467f389811eadeaf973960bb30f9fa7b9cb4678'
RELEASE_PROVENANCE = {'apiSource': 'e2c81c045fa16490c7515fa80573418e60ef4017', 'agentSource': VERSION, 'publishedBinarySha256': 'a59a4850337fe7af588267c481dee046db5baba4d3f705c85f19f85ded09e06f', 'rawHostShaObserved': False}
MODES = ['setup', 'turn-check', 'wake-check', 'observe', 'protected-snapshot', 'observer-snapshot', 'completion-runtime', 'resume-snapshot']


def save(root, name, value):
    fd = os.open(root / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream, separators=(',', ':'), sort_keys=True)


def restore_projection(rows, protected, own, mapping, wake, observed, started):
    """Fixed bounded projection, never arbitrary response strings or errors."""
    from datetime import datetime
    row = rows[0] if len(rows) == 1 else {}
    fields = ['id', 'snapshot_generation', 'recovery_status', 'recovery_task_id', 'recovery_workspace_id', 'restored_at']
    types = {k: type(row.get(k)).__name__ if type(row.get(k)) in [str, int, float, bool, list, dict, type(None)] else 'other' for k in fields}
    def ident(value):
        return value if isinstance(value, str) and re.fullmatch('[0-9A-HJKMNP-TV-Z]{26}', value) else None
    restored = row.get('restored_at'); restored_ms = None
    if isinstance(restored, str) and len(restored) <= 40 and re.fullmatch('[0-9T:.Z+ -]+', restored):
        try:
            parsed = datetime.fromisoformat(restored.replace('Z', '+00:00'))
            if parsed.tzinfo is not None: restored_ms = int(parsed.timestamp() * 1000)
        except (ValueError, OverflowError): pass
    wake_ms = wake.get('at') if isinstance(wake, dict) else None
    valid_wake = type(wake_ms) is int and started <= wake_ms <= observed and set(wake) == {'taskId', 'sessionId', 'at'} and wake.get('taskId') == own['taskId'] and wake.get('sessionId') == own['sessionId']
    generation = row.get('snapshot_generation')
    protected_generation = protected.get('snapshotGeneration')
    canonical = {'snapshotId': ident(row.get('id')), 'generationSha256': hashlib.sha256(generation.encode()).hexdigest() if isinstance(generation, str) and len(generation) <= 256 else None,
                 'protectedGenerationSha256': hashlib.sha256(protected_generation.encode()).hexdigest() if isinstance(protected_generation, str) and 0 < len(protected_generation) <= 128 else None,
                 'recoveryStatus': row.get('recovery_status') if row.get('recovery_status') in ['waking', 'restored', 'failed', None] else 'other',
                 'recoveryTaskId': ident(row.get('recovery_task_id')), 'recoveryWorkspaceId': ident(row.get('recovery_workspace_id')),
                 'restoredAtMs': restored_ms, 'wakeSubmittedAtMs': wake_ms if valid_wake else None}
    predicates = {'oneRow': len(rows) == 1, 'snapshotIdMatches': row.get('id') == protected.get('snapshotId'),
                  'generationMatches': isinstance(generation, str) and generation == protected.get('snapshotGeneration'),
                  'latestGenerationTyped': isinstance(generation, str) and 0 < len(generation) <= 128,
                  'statusRestored': row.get('recovery_status') == 'restored', 'taskMatches': row.get('recovery_task_id') == own['taskId'],
                  'workspaceMatches': row.get('recovery_workspace_id') == mapping['workspaceId'], 'restoredAtPresent': bool(restored),
                  'restoredAtParseable': restored_ms is not None, 'wakeReceiptValid': bool(valid_wake),
                  'restoredAfterWake': bool(valid_wake and restored_ms is not None and wake_ms <= restored_ms <= observed)}
    return {'observedAt': observed, 'canonical': canonical, 'types': types, 'predicates': predicates, 'consumedGenerationObserved': False}


def main():
    stage = 'configuration'
    root = config = own = None
    mode = None
    failure_source_sha = None
    restore_evidence = None
    try:
        mode = sys.argv[1]
        assert mode in MODES
        root = Path(os.environ['SAM_PROSPECTIVE_ROOT'])
        assert root.is_absolute() and root.is_dir() and not root.is_symlink()
        config = json.loads((root / 'config.json').read_text())
        own = config['observer' if mode in ['observe','observer-snapshot'] else 'own']
        assert re.fullmatch('[0-9A-HJKMNP-TV-Z]{26}', own['taskId'])
        assert re.fullmatch('[0-9a-f-]{36}', own['sessionId'])
        assert own['receipt'] == {'taskId': own['taskId'], 'sessionId': own['sessionId'], 'branchName': own['branch'], 'status': 'queued'}
        stage = 'settings'
        base = 'https://api.cloudflare.com/client/v4/accounts/' + os.environ['CF_ACCOUNT_ID']
        headers = {'Authorization': 'Bearer ' + os.environ['CF_TOKEN'], 'Content-Type': 'application/json'}

        def req(path, data=None):
            with urllib.request.urlopen(urllib.request.Request(base + path, headers=headers, data=None if data is None else json.dumps(data).encode()), timeout=15) as response:
                return json.load(response)
        bindings = req('/workers/scripts/sam-api-staging/settings')['result']['bindings']
        assert next(x.get('text') for x in bindings if x.get('name') == 'VM_AGENT_REQUIRED_VERSION') == VERSION
        database = next(x['id'] for x in bindings if x.get('name') == 'DATABASE')

        def q(sql, params):
            return req('/d1/database/' + database + '/query', {'sql': sql, 'params': params})['result'][0]['results']
        stage = 'task'
        rows = q('SELECT id,user_id,project_id,chat_session_id,workspace_id,output_branch,agent_profile_hint,status,claimed_warm_node_id,completed_at FROM tasks WHERE id=?', [own['taskId']])
        assert len(rows) == 1
        task = rows[0]
        assert task['project_id'] == PROJECT and task['chat_session_id'] == own['sessionId'] and task['output_branch'] == own['branch'] and task['agent_profile_hint'] == own['agentProfileId']
        owner = task['user_id']
        source = {'task': task}
        stage = 'resource-guards'
        nodes = q("SELECT id FROM nodes WHERE user_id=? AND runtime='vm' AND status!='deleted'", [owner])
        assert len(nodes) <= 1
        claims = q("SELECT id FROM tasks WHERE user_id=? AND id!=? AND claimed_warm_node_id IS NOT NULL AND status NOT IN ('completed','cancelled','failed')", [owner, own['taskId']])
        assert not claims
        observed = int(time.time() * 1000)
        if mode == 'completion-runtime':
            stage = 'completion-runtime'
            assert task['status'] == 'completed' and task['claimed_warm_node_id'] is None
            work = q("SELECT id FROM workspaces WHERE project_id=? AND chat_session_id=? AND status NOT IN ('deleted','stopped','sleeping')", [PROJECT, own['sessionId']])
            assert not work
            value = {'taskId': own['taskId'], 'sessionId': own['sessionId'], 'runtimeWorkTerminal': True, 'observedAt': observed}
        elif mode in ['protected-snapshot','observer-snapshot','resume-snapshot']:
            stage = 'snapshot'
            slept = json.loads((root / ('resume-snapshot-request.json' if mode == 'resume-snapshot' else 'observer-sleep.json' if mode == 'observer-snapshot' else 'protected-sleep.json')).read_text())
            if mode == 'resume-snapshot':
                assert own['taskId'] == '01M51Q2J7AQEKAKZAKZ39NFXWP' and own['sessionId'] == 'f5f56c5b-e9fb-4218-b327-bd9d4b7e25e9' and own['agentProfileId'] == '01KRS7Z2R88JFC73ARA7DV9WTK' and own['branch'] == 'sam/authorized-one-clean-prospective-9nfxwp'
                assert config['resume'] == {'kind': 'second-prospective-restore', 'originalEvidenceSha256': '9715d238b6fcf5cc1e45e065ea041e87e8b72b38b6776664827467a6e74c14d2'}
                assert task['status'] == 'sleeping' and task['claimed_warm_node_id'] is None and not nodes
                assert slept['taskId'] == own['taskId'] and slept['sessionId'] == own['sessionId'] and slept['workspaceId'] == task['workspace_id'] and config['started'] <= slept['at'] <= observed
                assert not q("SELECT id FROM workspaces WHERE project_id=? AND chat_session_id=? AND status NOT IN ('deleted','stopped','sleeping')", [PROJECT, own['sessionId']])
            rows = q('SELECT id,user_id,project_id,chat_session_id,workspace_id,runtime,status,degradation,expires_at,sleeping_at,snapshot_generation,home_sha256,wip_sha256,recovery_status,recovery_claimed_at FROM session_snapshots WHERE chat_session_id=?', [own['sessionId']])
            assert len(rows) == 1
            row = rows[0]
            if mode == 'resume-snapshot':
                # e2 claims the snapshot BEFORE reactivating the sleeping task.
                # Historical restored/failed IDs/times may remain; an active claim may not.
                assert row['recovery_status'] in [None, 'restored', 'failed'] and row['recovery_claimed_at'] is None
            assert row['user_id'] == owner and row['project_id'] == PROJECT and row['workspace_id'] == slept['workspaceId'] and row['status'] == 'available' and row['runtime'] == ('cf-container' if mode == 'observer-snapshot' else 'vm') and row['degradation'] == 'none'
            assert row['snapshot_generation'] and row['expires_at'] > time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime(config['hard'] / 1000))
            source['snapshot'] = row
            value = {'taskId': own['taskId'], 'sessionId': own['sessionId'], 'workspaceId': row['workspace_id'], 'snapshotId': row['id'], 'status': row['status'], 'runtime': row['runtime'], 'degradation': row['degradation'], 'expiresAt': row['expires_at'], 'snapshotGeneration': row['snapshot_generation'], 'observedAt': observed}
        else:
            stage = 'mapping'
            mapping = json.loads((root / (mode + '-mapping.json')).read_text())
            assert mapping['taskId'] == own['taskId'] and mapping['sessionId'] == own['sessionId'] and task['workspace_id'] == mapping['workspaceId']
            rows = q('SELECT id,user_id,project_id,chat_session_id,node_id,branch,status FROM workspaces WHERE id=?', [mapping['workspaceId']])
            assert len(rows) == 1
            workspace = rows[0]
            assert workspace['user_id'] == owner and workspace['project_id'] == PROJECT and workspace['chat_session_id'] == own['sessionId'] and workspace['node_id'] == mapping['nodeId'] and workspace['branch'] == own['branch'] and workspace['status'] == 'running'
            rows = q('SELECT id,user_id,runtime,agent_version,capacity_pool_revision,status FROM nodes WHERE id=?', [workspace['node_id']])
            assert len(rows) == 1
            node = rows[0]
            runtime = 'cf-container' if mode == 'observe' else 'vm'
            assert node['user_id'] == owner and node['runtime'] == runtime and node['status'] == 'running'
            if runtime == 'vm':
                assert node['agent_version'] == VERSION and node['capacity_pool_revision'] == 40 and len(nodes) == 1 and nodes[0]['id'] == node['id']
            rows = q('SELECT id,user_id,project_id,agent_type,runtime,vm_size_override FROM agent_profiles WHERE id=?', [own['agentProfileId']])
            assert len(rows) == 1
            profile = rows[0]
            assert profile['agent_type'] == own['agentType'] and profile['runtime'] in [None, runtime] and profile['vm_size_override'] is None and (profile['project_id'] == PROJECT or (profile['project_id'] is None and profile['user_id'] == owner))
            others = q("SELECT id FROM workspaces WHERE node_id=? AND id!=? AND status NOT IN ('deleted','stopped','sleeping')", [node['id'], workspace['id']])
            assert not others
            source.update(workspace=workspace, node=node, profile=profile)
            value = {'workspaceId': workspace['id'], 'nodeId': node['id'], 'ownerId': owner, 'expectedProfileOwnerId': profile['user_id'], 'agentSessionId': mapping['agentSessionId'], 'runtime': runtime, 'agentVersion': node['agent_version'], 'storedProfileId': profile['id'], 'storedProfileObservedAt': observed, 'expiresAt': observed + 240000, 'receipt': own['receipt'], 'globalVmCount': len(nodes), 'otherWorkspaceCount': 0, 'activeForeignClaimCount': 0}
            if runtime == 'vm':
                value['releaseProvenance'] = RELEASE_PROVENANCE
                source['reviewedPublicationReference'] = RELEASE_PROVENANCE
            if mode == 'wake-check':
                stage = 'restored-generation'
                protected = json.loads((root / 'protected-snapshot.json').read_text())
                rows = q('SELECT id,snapshot_generation,recovery_status,recovery_task_id,recovery_workspace_id,restored_at FROM session_snapshots WHERE chat_session_id=?', [own['sessionId']])
                try: wake = json.loads((root / 'wake-submitted.json').read_text())
                except (OSError, ValueError): wake = {}
                projection = restore_projection(rows, protected, own, mapping, wake, int(time.time() * 1000), config['started'])
                save(root, 'wake-check-restore-source.json', projection)
                raw_projection = (root / 'wake-check-restore-source.json').read_bytes()
                failure_source_sha = hashlib.sha256(raw_projection).hexdigest()
                restore_evidence = {'observedAt': projection['observedAt'], 'predicates': projection['predicates'], 'types': projection['types'], 'sourceEvidenceSha256': failure_source_sha}
                # A normal post-wake idle checkpoint can rotate the latest generation.
                # Equality is an observation, never immutable consumed-restore proof.
                assert all(v for k, v in projection['predicates'].items() if k != 'generationMatches')
                assert projection['canonical']['protectedGenerationSha256'] is not None
                row = rows[0]
                from datetime import datetime
                value['recoveredSnapshotId'] = row['id']
                value['snapshotRestoreConfirmedAt'] = int(datetime.fromisoformat(row['restored_at'].replace('Z', '+00:00')).timestamp() * 1000)
                value['restoreProvenance'] = {'protectedGenerationSha256': projection['canonical']['protectedGenerationSha256'],
                     'latestGenerationSha256': projection['canonical']['generationSha256'],
                     'latestGenerationMatchesProtected': projection['predicates']['generationMatches'], 'consumedGenerationObserved': False}
                source['restored'] = projection
        stage = 'evidence'
        raw = json.dumps(source, separators=(',', ':'), sort_keys=True)
        digest = hashlib.sha256(raw.encode()).hexdigest()
        save(root, mode + '-source.json', source)
        value['sourceEvidenceSha256'] = digest
        filename = mode + '.json' if mode in ['protected-snapshot', 'observer-snapshot', 'resume-snapshot', 'completion-runtime'] else mode + '-grant.json'
        save(root, filename, value)
        print(json.dumps({'ok': True, 'stage': 'done', 'observedAt': observed}))
    except Exception:
        # No grants or reconstructed success. Exclusive failure evidence is bound to
        # this exact operation clock and lets the existing caller finally run early.
        if root is not None and config is not None and own is not None and mode in MODES:
            try:
                save(root, mode + '-failure.json', {'mode': mode, 'taskId': own['taskId'], 'sessionId': own['sessionId'],
                     'started': config['started'], 'hard': config['hard'], 'stage': stage,
                     'observedAt': int(time.time() * 1000), 'sourceEvidenceSha256': failure_source_sha})
            except Exception: pass
        result = {'ok': False, 'stage': stage}
        if restore_evidence is not None: result['diagnostic'] = restore_evidence
        print(json.dumps(result))


if __name__ == '__main__':
    main()
