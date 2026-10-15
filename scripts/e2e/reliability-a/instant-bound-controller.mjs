/** Verification-only, two run-specific Instant contexts. MUST run under safe-controller supervisor. */
import {readFile,writeFile,stat} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {baselineArtifact,expectationsArtifact,probeArtifact} from './queue-controller.mjs';
const api='https://api.sammy.party',project='01KJNR9R3TEN3KX1ETE33852R8',repository='serverspresentation2025/crewai';
const ulid=x=>typeof x==='string'&&/^[0-9A-HJKMNP-TV-Z]{26}$/.test(x);
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(x);
const branch=x=>typeof x==='string'&&/^sam\/[a-z0-9][a-z0-9/-]{0,150}$/.test(x);
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join()===keys.slice().sort().join();
const integer=x=>Number.isSafeInteger(x)&&x>=0;
const when=x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(x)&&Number.isFinite(Date.parse(x));
const hash=x=>createHash('sha256').update(x).digest('hex');
const hashes={'b-probe.py':'889d7588ed44c8ab89e6ba7880ff20d81017f294bb7b31edfbc320ced064f509','git-probe.py':'b8721fa626cd111b7030b155071a013ad988e0f194d7157a9b9610a40f4d5568','terminal-observer.py':'d0970080ce89ab2810c0c9d758d1fc978efafe75fed91a4454f08639da88adff'};
export function validateConfig(c,now=Date.now(),allowExpired=false){
 if(!exact(c,['createdAt','expiresAt','contexts','cleanupAuthorized'])||!integer(c.createdAt)||!integer(c.expiresAt)
  ||c.createdAt>now||(!allowExpired&&c.expiresAt<=now)||c.expiresAt<=c.createdAt||c.expiresAt-c.createdAt>7_200_000||typeof c.cleanupAuthorized!=='boolean'
  ||!Array.isArray(c.contexts)||c.contexts.length!==2)throw new Error();
 const seen=new Set();
 c.contexts.forEach((x,i)=>{
  if(!exact(x,['taskId','sessionId','workspaceId','nodeId','branch','agentProfileId','agentType','receipt','evidencePrUrl','submittedAt'])
   ||![x.taskId,x.workspaceId,x.nodeId,x.agentProfileId].every(ulid)||!uuid(x.sessionId)||!branch(x.branch)
   ||x.agentType!==(i===0?'openai-codex':'claude-code')||!integer(x.submittedAt)||x.submittedAt<c.createdAt||x.submittedAt>now||x.submittedAt-c.createdAt>600_000
   ||!exact(x.receipt,['taskId','sessionId','branchName','status'])||x.receipt.taskId!==x.taskId||x.receipt.sessionId!==x.sessionId
   ||x.receipt.branchName!==x.branch||x.receipt.status!=='queued'
   ||!new RegExp('^https://github.com/'+repository+'/pull/[1-9][0-9]*$').test(x.evidencePrUrl))throw new Error();
  for(const field of ['taskId','sessionId','workspaceId','nodeId','branch']){const key=field+':'+x[field];if(seen.has(key))throw new Error();seen.add(key);}
 });return c;
}
export async function run({requestSafe,logoutSafe,summary,safeSummary}){
 let browser,context,result=summary('controller'),output=null,loggedOut=false,root;
 try{
  root=process.env.SAM_INSTANT_BOUND_ROOT;
  if(!root||!isAbsolute(root)||(await stat(root)).mode&0o077)throw new Error();
  for(const name of ['config.json','operation.json'])if((await stat(join(root,name))).mode&0o077)throw new Error();
  const op=JSON.parse(await readFile(join(root,'operation.json'),'utf8'));
  const c=validateConfig(JSON.parse(await readFile(join(root,'config.json'),'utf8')),Date.now(),op.kind==='cleanup');
  if(!exact(op,op.kind==='observe'?['kind','contextSlot','target']:['kind','contextSlot'])
   ||![0,1].includes(op.contextSlot)||!['prepare','check-record','wake-check','complete','observe','sleep','cleanup'].includes(op.kind))throw new Error();
  const own=c.contexts[op.contextSlot],now=Date.now();let end=Math.min(c.expiresAt,now+240_000);
  const ownPath=`/api/projects/${project}/tasks/${own.taskId}`,sessionPath=`/api/projects/${project}/sessions/${own.sessionId}`;
  const privateJson=async(name,value)=>writeFile(join(root,name),JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});
  const request=async(path,options={},accept)=>{
   const r=await requestSafe(context,api,{path,timeoutMs:10_000,...options},accept);
   if(r.category!=='ok')throw new Error();return r;
  };
  const token=process.env.SAM_PLAYWRIGHT_PRIMARY_USER;
  if(typeof token!=='string'||!token||token.startsWith('__SAM_SECRET_'))throw new Error();
  const {chromium}=await import('/tmp/reliability-browser-deps/node_modules/playwright/index.mjs');
  browser=await chromium.launch({headless:true});context=await browser.newContext();
  await request('/api/auth/token-login',{method:'POST',data:{token}});delete process.env.SAM_PLAYWRIGHT_PRIMARY_USER;
  let task,workspace,state;
  const bind=async(allowAbsent=false)=>{
   await request(ownPath,{},v=>{task=v;return v?.id===own.taskId&&v.projectId===project&&v.outputBranch===own.branch
    &&v.taskMode==='task'&&v.agentProfileHint===own.agentProfileId&&(v.workspaceId===own.workspaceId||(v.workspaceId===null&&['completed','sleeping','cancelled'].includes(v.status)));});
   const w=await requestSafe(context,api,{path:'/api/workspaces/'+own.workspaceId,timeoutMs:10_000},v=>{
    workspace=v;return v?.id===own.workspaceId&&v.projectId===project&&v.chatSessionId===own.sessionId&&v.nodeId===own.nodeId
     &&v.branch===own.branch&&v.repository===repository&&v.workspaceProfile==='lightweight';});
   if(allowAbsent&&w.status===404){workspace=null;return;}
   if(w.category!=='ok')throw new Error();
   await request('/api/nodes',{},v=>Array.isArray(v)&&v.filter(n=>n.id===own.nodeId).length===1
    &&v.some(n=>n.id===own.nodeId&&n.cloudProvider==='cloudflare'&&n.providerInstanceType==='cf-container'));
  };
  const readState=async()=>{
   let available=false;
   await request(sessionPath+'/state',{},v=>{
    if(!v||typeof v!=='object')return false;
    if(v.state===null){state=null;return true;}
    if(v.agentSessionId!==null&&!(ulid(v.agentSessionId)||uuid(v.agentSessionId)))return false;
    if(v.agentType!==null&&v.agentType!==own.agentType)return false;
    if(v.agentSessionId===null||v.agentType===null){state=null;return true;}
    state=v.state;available=true;return true;
   });return available;
  };
  const idle=()=>state?.activity==='idle'&&state.runtimeWorkState==='inactive'&&state.runtimeWorkCount===0
   &&integer(state.activityAt)&&integer(state.runtimeWorkUpdatedAt)&&state.activityAt>=own.submittedAt&&state.runtimeWorkUpdatedAt>=own.submittedAt
   &&state.activityAt<=Date.now()&&state.runtimeWorkUpdatedAt<=Date.now();
  const requireOriginalCompletion=async()=>{
   const proof=JSON.parse(await readFile(join(root,own.taskId+'-independent-proof.json'),'utf8'));
   if(!exact(proof,['taskId','branch','completedAt','checks','statuses'])||proof.taskId!==own.taskId||proof.branch!==own.branch
    ||!when(proof.completedAt)||proof.completedAt!==task.completedAt)throw new Error();
   const safe=probeArtifact({checks:proof.checks,statuses:proof.statuses},'observer-check');
   if(!Object.values(safe.checks).every(Boolean)||Object.values(safe.statuses).some(x=>x!==0))throw new Error();
  };
  await bind(op.kind==='cleanup');
  if(op.kind==='cleanup'){
   if(!c.cleanupAuthorized)throw new Error();
   if(workspace){
    await request(sessionPath+'/stop',{method:'POST',data:{}},v=>v?.status==='stopped'&&v.workspaceDeleted===true);
    // Stop may delete the exact workspace. Revalidate ownership before any remaining DELETE.
    await bind(true);
    if(workspace){
     await request('/api/workspaces/'+own.workspaceId,{method:'DELETE'},v=>v?.success===true&&v.deletionStatus==='confirmed');
     const absent=await requestSafe(context,api,{path:'/api/workspaces/'+own.workspaceId,timeoutMs:10_000});if(absent.status!==404)throw new Error();
    }
   }
   output={taskId:own.taskId,workspaceId:own.workspaceId,workspace404:true};
  }else if(op.kind==='sleep'){
   if(workspace.status!=='sleeping'){
    await readState();if(!idle())throw new Error();await bind();
    await request('/api/workspaces/'+own.workspaceId+'/sleep',{method:'POST',data:{}},v=>v?.status==='sleeping'
     &&v.workspaceId===own.workspaceId&&v.chatSessionId===own.sessionId&&when(v.snapshotExpiresAt));
   }
   output={taskId:own.taskId,sessionId:own.sessionId,retainedSleeping:true};
  }else{
   if(task.status==='completed'){
    if(op.kind!=='observe')throw new Error();await requireOriginalCompletion();
    await privateJson(own.taskId+'-before-reopen.json',{taskId:own.taskId,branch:own.branch,completedAt:task.completedAt,reopened:true});
   }
   let target,baseline,expectations,completedAt;
   if(op.kind==='observe'){
    target=op.target;
    if(!exact(target,['taskId','branch','baseline','expectations'])||!ulid(target.taskId)||target.taskId===own.taskId||!branch(target.branch))throw new Error();
    baseline=baselineArtifact(target.baseline,target.branch);expectations=expectationsArtifact(target.expectations,baseline,repository);
    await request(`/api/projects/${project}/tasks/${target.taskId}`,{},v=>{
     completedAt=v?.completedAt;return v?.id===target.taskId&&v.projectId===project&&v.outputBranch===target.branch&&v.status==='completed'
      &&when(completedAt)&&Date.parse(completedAt)>Date.parse(expectations.recordedAt)&&Date.parse(completedAt)<=Date.now()
      &&v.completionEvidence!==null&&typeof v.completionEvidence==='object';
    });
    await privateJson(target.taskId+'-canonical-completed.json',{taskId:target.taskId,branch:target.branch,completedAt});
   }else{
    const marker=join(root,own.taskId+'-phase-start.json');
    if(op.kind==='prepare')await privateJson(own.taskId+'-phase-start.json',{startedAt:now});
    const phase=JSON.parse(await readFile(marker,'utf8'));
    if(!exact(phase,['startedAt'])||!integer(phase.startedAt)||Date.now()-phase.startedAt>=780_000||phase.startedAt>now)throw new Error();
    end=Math.min(end,phase.startedAt+780_000); // Reserve the final two minutes for logout/retention/own cleanup.
   }
   const assets={};for(const [name,expected] of Object.entries(hashes)){
    const bytes=await readFile(new URL('./'+name,import.meta.url));if(hash(bytes)!==expected)throw new Error();assets[name]=bytes.toString('utf8');
   }
   if(op.kind==='observe'){assets['baseline.json']=JSON.stringify(baseline);assets['expectations.json']=JSON.stringify(expectations);}
   const assetHashes=Object.fromEntries(Object.entries(assets).map(([name,bytes])=>[name,hash(bytes)]));
   const bundle=gzipSync(JSON.stringify(assets)).toString('base64');
   const folder='/workspaces/reliability-observer-assets/'+(target?.taskId??own.taskId);
   let instructions;
   if(op.kind==='observe')instructions=`Run ONLY ${folder}/terminal-observer.py check --repository ${repository} --branch ${target.branch} --baseline ${folder}/baseline.json --expectations ${folder}/expectations.json --terminal-completed-at ${completedAt} --pr-limit ${expectations.prLimit}. Use exact baseline.json and expectations.json from the same validated bundle outside Git. Redirect only observer stdout to ${folder}/observer-check.json, stderr PRIVATE. Upload original file bytes to a NEW task-scoped Library directory; report fileID only. No git-probe check of observer's own old fixture.`;
   else if(op.kind==='prepare')instructions=`From canonical repository root ONLY run ${folder}/git-probe.py prepare --disposable-repository, stdout alone ${folder}/a-prepare.json, stderr PRIVATE. Upload ORIGINAL phase stdout and ORIGINAL .reliability-a/baseline.json separately. Return idle; no completion.`;
   else if(op.kind==='check-record')instructions=`From canonical repository root run ONLY ${folder}/git-probe.py check to ${folder}/a-check.json; then ${folder}/terminal-observer.py record --repository ${repository} --branch ${own.branch} --baseline .reliability-a/baseline.json --expectations ${folder}/expectations.json to ${folder}/observer-record.json. Stdout only, stderr PRIVATE. Upload all three original files separately, no reformatted JSON. Return idle.`;
   else if(op.kind==='wake-check')instructions=`NORMAL owner wake: from canonical restored repository root run ONLY ${folder}/git-probe.py check against EXISTING .reliability-a/baseline.json, stdout ${folder}/a-check.json, stderr PRIVATE. NEVER prepare or recreate baseline. Upload ORIGINAL check file to NEW unique task-scoped evidence directory; return idle.`;
   else instructions=`From canonical repository root run ONLY ${folder}/git-probe.py check, stdout ${folder}/a-check.json, stderr PRIVATE; upload original bytes. ONLY if all actual checks true/status0, call actual complete_task with evidence.prUrl=${own.evidencePrUrl} and measured local commit SHA in evidence.notes/verifications (not unsupported commitSha property). Report no publication. Do NOT push/create PR/alter files. Actual task completion is last.`;
   const content=`Authorized bounded Reliability acceptance ${op.kind}; exact task ${own.taskId}, session ${own.sessionId}, branch ${own.branch}. Use existing Python only, no installs/sudo. Recreate ONLY external assets ${folder} from exact gzip/base64 JSON bundle ${bundle}; hash map ${JSON.stringify(assetHashes)}; preserve script bytes, decode quietly and verify hashes privately. All credential/helper/stdout/stderr/error streams PRIVATE, report fixed booleans/status/fileIDs only; no helper Read/free negative commands. NO publication, repo edits (except prepare's exact fixture), new task, PR or background work. ${instructions}`;
   if(content.length>16000)throw new Error();
   if(workspace.status!=='sleeping'&&task.status!=='completed'){await readState();if(!idle())throw new Error();}
   await bind();
   const submittedAt=Date.now();
   await request(sessionPath+'/prompt',{method:'POST',data:{content}},v=>v?.accepted===true&&v.status==='queued');let done=false;
   while(Date.now()<end){
    if(op.kind==='complete'){
     await request(ownPath,{},v=>{task=v;return v?.id===own.taskId&&v.projectId===project&&v.outputBranch===own.branch;});
     if(task.status==='completed'&&when(task.completedAt)&&Date.parse(task.completedAt)>=submittedAt){
      output={taskId:own.taskId,branch:own.branch,completedAt:task.completedAt};done=true;break;
     }
    }else if(await readState()){
     if(idle()&&state.activityAt>=submittedAt&&state.runtimeWorkUpdatedAt>=submittedAt){done=true;break;}
    }
    await new Promise(resolve=>setTimeout(resolve,1000));
   }
   if(!done)throw new Error();
   if(op.kind==='observe'){
    // Caller supplies only the independently located task-scoped upload ID; never raw model output.
    let artifact;
    while(Date.now()<end){try{artifact=JSON.parse(await readFile(join(root,'observer-artifact.json'),'utf8'));break;}catch{await new Promise(resolve=>setTimeout(resolve,500));}}
    if(!exact(artifact,['artifactId','taskId'])||!ulid(artifact.artifactId)||artifact.taskId!==own.taskId)throw new Error();
    let proof;
    await request(`/api/projects/${project}/library/${artifact.artifactId}/download`,{},v=>{
     proof=probeArtifact(v,'observer-check');return Object.values(proof.checks).every(Boolean)&&Object.values(proof.statuses).every(x=>x===0);
    });
    output={taskId:target.taskId,branch:target.branch,completedAt,...proof};
    await privateJson(target.taskId+'-independent-proof.json',output);
    await bind();await readState();if(!idle())throw new Error();
    await request('/api/workspaces/'+own.workspaceId+'/sleep',{method:'POST',data:{}},v=>v?.status==='sleeping'&&v.workspaceId===own.workspaceId&&v.chatSessionId===own.sessionId&&when(v.snapshotExpiresAt));
   }else output??={taskId:own.taskId,sessionId:own.sessionId,phase:op.kind,turnEnded:true};
  }
  result=summary('ok',200,true);
 }catch{result=summary('controller');output=null;}
 finally{
  delete process.env.SAM_PLAYWRIGHT_PRIMARY_USER;
  if(context)try{
   const logout=await logoutSafe(context,api);
   const absent=await requestSafe(context,api,{path:'/api/auth/get-session'},v=>v===null);
   const denied=await requestSafe(context,api,{path:'/api/nodes'});
   loggedOut=logout.category==='ok'&&absent.category==='ok'&&[401,403].includes(denied.status);
  }catch{loggedOut=false;}
  if(browser)try{await browser.close();}catch{loggedOut=false;}
 }
 if(output&&loggedOut)try{await writeFile(join(root,'result.json'),JSON.stringify(output)+'\n',{flag:'wx',mode:0o600});return safeSummary(result);}catch{}
 return safeSummary(summary('controller'));
}
