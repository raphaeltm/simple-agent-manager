import os,json,urllib.request,time
from pathlib import Path
out={'observedAtMs':int(time.time()*1000),'ok':False}
try:
 base='https://api.cloudflare.com/client/v4/accounts/'+os.environ['CF_ACCOUNT_ID'];headers={'Authorization':'Bearer '+os.environ['CF_TOKEN'],'Content-Type':'application/json'}
 def req(p,d=None):
  with urllib.request.urlopen(urllib.request.Request(base+p,headers=headers,data=None if d is None else json.dumps(d).encode()),timeout=15) as r:return json.load(r)['result']
 bs=req('/workers/scripts/sam-api-staging/settings')['bindings'];db=next(x['id'] for x in bs if x.get('name')=='DATABASE')
 rows=req('/d1/database/'+db+'/query',{'sql':"SELECT t.id,t.status,t.workspace_id,t.claimed_warm_node_id,w.status workspace_status,w.node_id,n.status node_status,n.runtime,n.agent_version,n.capacity_pool_revision,n.warm_since FROM tasks t LEFT JOIN workspaces w ON w.id=t.workspace_id LEFT JOIN nodes n ON n.id=w.node_id WHERE t.id=?",'params':['01M527WRMMRR56ESJF21NW6EV0']})[0]['results']
 out['rows']=rows
 def q(sql,params=[]):return req('/d1/database/'+db+'/query',{'sql':sql,'params':params})[0]['results']
 out['node']=q('SELECT id,status,warm_since,runtime_termination_confirmed_at FROM nodes WHERE id=?',['01M527X0B4TBRSGZCZ13P4V4WG'])
 out['snapshots']=q('SELECT id,status,degradation,expires_at,sleeping_at FROM session_snapshots WHERE chat_session_id=?',['8d0245f8-8799-40c1-9848-4650dd5b90d4'])
 out['activeSameSessionWorkspaces']=q("SELECT COUNT(*) n FROM workspaces WHERE chat_session_id=? AND status NOT IN ('deleted','stopped','sleeping')",['8d0245f8-8799-40c1-9848-4650dd5b90d4'])[0]['n']
 out['nodeActiveWorkspaces']=q("SELECT COUNT(*) n FROM workspaces WHERE node_id=? AND status NOT IN ('deleted','stopped','sleeping')",['01M527X0B4TBRSGZCZ13P4V4WG'])[0]['n']
 out['nodeWarmClaims']=q("SELECT COUNT(*) n FROM tasks WHERE claimed_warm_node_id=? AND status NOT IN ('completed','cancelled','failed')",['01M527X0B4TBRSGZCZ13P4V4WG'])[0]['n']
 out['ok']=True
except Exception:pass
Path('/workspaces/simple-agent-manager/.agent-evidence/01M527WRMMRR56ESJF21NW6EV0/cleanup-canonical.json').write_text(json.dumps(out,sort_keys=True,indent=2)+'\n');print(json.dumps(out))
