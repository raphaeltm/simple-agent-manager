import os,json,urllib.request,time,datetime,hashlib
from pathlib import Path
out={'observedAtMs':int(time.time()*1000),'checks':{},'counts':{}};stage='settings';project='01KJNR9R3TEN3KX1ETE33852R8';task='01M51Q2J7AQEKAKZAKZ39NFXWP';c=out['checks']
try:
 base='https://api.cloudflare.com/client/v4/accounts/'+os.environ['CF_ACCOUNT_ID']
 def req(path,data=None):
  r=urllib.request.Request(base+path,headers={'Authorization':'Bearer '+os.environ['CF_TOKEN'],'Content-Type':'application/json'},data=None if data is None else json.dumps(data).encode())
  with urllib.request.urlopen(r,timeout=15) as s:return json.load(s)['result']
 bindings=req('/workers/scripts/sam-api-staging/settings')['bindings'];db=next(x['id'] for x in bindings if x.get('name')=='DATABASE')
 c['requiredAgentPin']=next(x.get('text') for x in bindings if x.get('name')=='VM_AGENT_REQUIRED_VERSION')=='b467f389811eadeaf973960bb30f9fa7b9cb4678'
 d=req('/workers/scripts/sam-api-staging/deployments')['deployments'][0];out['workerDeployment']={'id':d['id'],'createdOn':d['created_on'],'versions':d['versions']}
 def q(sql,params=[]):return req('/d1/database/'+db+'/query',{'sql':sql,'params':params})[0]['results']
 def zero(k,sql,params=[]):
  n=q(sql,params)[0]['n'];out['counts'][k]=n;c[k]=n==0
 stage='identity'
 t=q('SELECT user_id,project_id,chat_session_id,status,capacity_pool_id FROM tasks WHERE id=?',[task]);assert len(t)==1;owner=t[0]['user_id'];pool=t[0]['capacity_pool_id']
 c['oldTargetPreservedSleeping']=t[0]['status']=='sleeping';c['projectIdentity']=t[0]['project_id']==project
 p=q('SELECT user_id,repository FROM projects WHERE id=?',[project]);c['projectOwnerRepository']=len(p)==1 and p[0]['user_id']==owner and p[0]['repository']=='serverspresentation2025/crewai'
 a=q('SELECT user_id,project_id,agent_type,runtime,vm_size_override FROM agent_profiles WHERE id=?',['01KRS7Z2R88JFC73ARA7DV9WTK']);c['claudeProfileBinding']=len(a)==1 and a[0]['agent_type']=='claude-code' and a[0]['runtime'] in [None,'vm'] and a[0]['vm_size_override'] is None and (a[0]['project_id']==project or (a[0]['project_id'] is None and a[0]['user_id']==owner))
 stage='resource-guards'
 zero('globalVmZero',"SELECT COUNT(*) n FROM nodes WHERE runtime='vm' AND status!='deleted'")
 zero('globalWarmClaimsZero',"SELECT COUNT(*) n FROM tasks WHERE claimed_warm_node_id IS NOT NULL AND status NOT IN ('completed','cancelled','failed')")
 zero('unexpiredProvisioningLeasesZero',"SELECT COUNT(*) n FROM vm_provisioning_leases WHERE julianday(expires_at)>julianday('now')")
 zero('projectActiveRecoveryZero',"SELECT COUNT(*) n FROM session_snapshots WHERE project_id=? AND (recovery_claimed_at IS NOT NULL OR recovery_status='waking')",[project])
 zero('projectActiveRecoveryTasksZero',"SELECT COUNT(*) n FROM tasks WHERE project_id=? AND recovery_source_task_id IS NOT NULL AND status NOT IN ('completed','cancelled','failed','sleeping')",[project])
 zero('projectActiveProspectiveDuplicatesZero',"SELECT COUNT(*) n FROM tasks WHERE project_id=? AND output_branch LIKE 'sam/authorized-one-clean-prospective-%' AND status NOT IN ('completed','cancelled','failed','sleeping')",[project])
 zero('targetActiveWorkspacesZero',"SELECT COUNT(*) n FROM workspaces WHERE project_id=? AND chat_session_id=? AND status NOT IN ('deleted','stopped','sleeping')",[project,t[0]['chat_session_id']])
 stage='pool-catalog'
 pools=q('SELECT revision,status,configuration_state,max_nodes,strategy FROM capacity_pools WHERE id=?',[pool]);assert len(pools)==1;pl=pools[0];out['pool']={'revision':pl['revision'],'maxNodes':pl['max_nodes'],'strategy':pl['strategy']};c['pool40Ready']=pl['revision']==40 and pl['status']=='active' and pl['configuration_state']=='configured-ready'
 offers=q("SELECT c.provider,c.runtime,c.provider_instance_type,c.provider_instance_price_currency,c.provider_instance_price_hourly_micros,c.provider_instance_catalog_last_seen_at,c.catalog_availability,s.status source_status FROM capacity_pool_candidates c JOIN capacity_sources s ON s.id=c.capacity_source_id WHERE c.pool_id=? AND c.status='active' AND c.workload_role='workspace'",[pool]);out['catalogue']=[{'provider':x['provider'],'runtime':x['runtime'],'type':x['provider_instance_type'],'currency':x['provider_instance_price_currency'],'hourlyMicros':x['provider_instance_price_hourly_micros'],'lastSeenAt':x['provider_instance_catalog_last_seen_at'],'available':x['catalog_availability']=='available','sourceActive':x['source_status']=='active'} for x in offers]
 c['catalogueAvailable']=bool(offers) and all(x['catalog_availability']=='available' and x['source_status']=='active' for x in offers)
 costs=[x['provider_instance_price_hourly_micros'] for x in offers if x['runtime']=='vm' and x['provider']=='hetzner' and x['provider_instance_price_currency']=='EUR'];c['cataloguePriced']=bool(costs) and all(isinstance(n,int) and n>0 for n in costs)
 if c['cataloguePriced']:out['planningCost']={'activePlusTailVmMinutes':85,'roundedHours':2,'minComputeEur':2*min(costs)/1000000,'maxComputeEur':2*max(costs)/1000000,'excludes':'IP,tax,API,storage,provider-delay'}
 stage='protected-snapshots'
 f=q('SELECT status FROM tasks WHERE id=?',['01M50VYZ60RQXXTGSVPXW6FRXD']);c['firstCompleted']=len(f)==1 and f[0]['status']=='completed'
 rows=q('SELECT id,chat_session_id,status,degradation,expires_at FROM session_snapshots WHERE project_id=?',[project]);limit=(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(minutes=90)).isoformat().replace('+00:00','Z')
 protected=['4e5282b9-0cd5-454f-a8f0-db160b9823fe','f5f56c5b-e9fb-4218-b327-bd9d4b7e25e9'];out['protectedSnapshots']=[{'id':r['id'],'sessionId':r['chat_session_id'],'available':r['status']=='available','undegraded':r['degradation']=='none','expiresBeyond90min':r['expires_at']>limit} for r in rows if r['chat_session_id'] in protected];c['requiredSnapshotsRetained']=len(out['protectedSnapshots'])==2 and all(r['available'] and r['undegraded'] and r['expiresBeyond90min'] for r in out['protectedSnapshots'])
 out['ok']=all(c.values())
except Exception:out['ok']=False;out['failedStage']=stage
Path('/workspaces/simple-agent-manager/.agent-evidence/reliability-a-fresh-return-20261016/cf-guards.json').write_text(json.dumps(out,sort_keys=True,indent=2)+'\n');print(json.dumps(out,separators=(',',':')))
