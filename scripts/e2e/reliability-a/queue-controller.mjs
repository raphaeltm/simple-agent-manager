/** Verification-only trusted entrypoint. Run ONLY under safe-controller.mjs supervise. */
import {mkdir,readdir,readFile,writeFile,unlink} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';

const ulid=v=>typeof v==='string'&&/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(v);
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(v);
const agentIdentity=v=>ulid(v)||uuid(v);
const branch=v=>typeof v==='string'&&/^sam\/[a-z0-9][a-z0-9/-]{0,150}$/u.test(v);
const hex=v=>typeof v==='string'&&/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(v);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===keys.slice().sort().join();
const files=['.reliability-a/tracked.txt','.reliability-a/staged-new.txt','.reliability-a/untracked.txt','.do-state.md','.workflow-state.md'];
const observerWhen=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/u.test(v)&&Number.isFinite(Date.parse(v));
const when=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u.test(v)&&Number.isFinite(Date.parse(v));
function refs(text){
  if(typeof text!=='string'||!text.trim())throw new Error();
  const result={};
  for(const line of text.split('\n')){
    const m=/^([0-9a-f]{40}|[0-9a-f]{64})\t(refs\/heads\/[A-Za-z0-9._/-]+)$/u.exec(line);
    if(!m||Object.hasOwn(result,m[2])||/gh[sopur]_|github_pat_/u.test(m[2]))throw new Error();
    result[m[2]]=m[1];
  }
  return result;
}
export function baselineArtifact(value, expectedBranch){
  if(!branch(expectedBranch)||!exact(value,['head','branch','index','status','files','stagedTracked','stagedNew','remoteRefs'])
    ||value.branch!==expectedBranch||!hex(value.head)||!hex(value.index)||!exact(value.files,files)
    ||Object.values(value.files).some(v=>typeof v!=='string'||!/^[0-9a-f]{64}$/u.test(v))
    ||value.stagedTracked!=='staged tracked content'||value.stagedNew!=='staged new content'||typeof value.status!=='string')throw new Error();
  for(const line of value.status.split('\n').filter(Boolean)){
    if(!/^[ MADRCU?!]{2} /u.test(line)||!files.includes(line.slice(3)))throw new Error();
  }
  refs(value.remoteRefs);
  return {head:value.head,branch:value.branch,index:value.index,status:value.status,
    files:Object.fromEntries(files.map(k=>[k,value.files[k]])),stagedTracked:value.stagedTracked,stagedNew:value.stagedNew,remoteRefs:value.remoteRefs};
}
export function expectationsArtifact(value, baseline, repository){
  if(!exact(value,['repository','branch','remoteRefs','prs','recordedAt','prLimit'])||value.repository!==repository
    ||value.branch!==baseline.branch||!observerWhen(value.recordedAt)||!Number.isSafeInteger(value.prLimit)||value.prLimit<1||value.prLimit>1000
    ||!Array.isArray(value.prs)||value.prs.length>=value.prLimit)throw new Error();
  const expected=refs(baseline.remoteRefs);
  if(!exact(value.remoteRefs,Object.keys(expected))||Object.keys(expected).some(k=>value.remoteRefs[k]!==expected[k]))throw new Error();
  const seen=new Set();
  const prs=value.prs.map(p=>{
    if(!exact(p,['number','url','state','headRefName'])||!Number.isSafeInteger(p.number)||p.number<1||seen.has(p.number)
      ||!['OPEN','CLOSED','MERGED'].includes(p.state)||p.headRefName!==baseline.branch
      ||p.url!==`https://github.com/${repository}/pull/${p.number}`)throw new Error();
    seen.add(p.number);return {number:p.number,url:p.url,state:p.state,headRefName:p.headRefName};
  }).sort((a,b)=>a.number-b.number);
  return {repository,branch:baseline.branch,remoteRefs:expected,prs,recordedAt:value.recordedAt,prLimit:value.prLimit};
}
const probeLabels=new Set(['helperTimeout30','helperSimpleAbsolutePath','useHttpPath','http.lowSpeedLimitUnsetOrNumeric','http.lowSpeedTimeUnsetOrNumeric','missingPathReturnedCredential','foreignHostDenied','privateGitAccess','privateGhAccess','installedReleaseMatches','installedBinaryMatches','beforeABaseline','privateClone','testCommitTreeUnchanged','explicitPush','probeCompleted','prepared','localCommitUnpublished','headUnchanged','branchUnchanged','indexUnchanged','statusUnchanged','filesUnchanged','stagedTrackedUnchanged','stagedNewUnchanged','remoteRefsUnchanged','expectationsRecorded','taskBranchPrInventoryUnchanged','observedAfterTerminal','observerCompleted','assetHashesMatch']);
const statusLabels=new Set(['credential.helper','credential.useHttpPath','http.lowSpeedLimit','http.lowSpeedTime','missingPath','foreignHost','privateGitAccess','privateGhAccess','clone','name','email','branch','beforeTree','commit','afterTree','push','probe','remoteRefs','prInventory','observer','hash']);
export function probeArtifact(value,phase){
  if(!exact(value,['checks','statuses'])||!value.checks||typeof value.checks!=='object'||Array.isArray(value.checks)
    ||!value.statuses||typeof value.statuses!=='object'||Array.isArray(value.statuses)
    ||!Object.keys(value.checks).length||!Object.keys(value.statuses).length
    ||Object.entries(value.checks).some(([k,v])=>!probeLabels.has(k)||typeof v!=='boolean')
    ||Object.entries(value.statuses).some(([k,v])=>!statusLabels.has(k)||!Number.isSafeInteger(v)||v< -128||v>255))throw new Error();
  const inspect=['helperTimeout30','helperSimpleAbsolutePath','useHttpPath','http.lowSpeedLimitUnsetOrNumeric','http.lowSpeedTimeUnsetOrNumeric','missingPathReturnedCredential','foreignHostDenied','privateGitAccess','privateGhAccess','probeCompleted'];
  const inspectStatus=['credential.helper','credential.useHttpPath','http.lowSpeedLimit','http.lowSpeedTime','missingPath','foreignHost','privateGitAccess','privateGhAccess'];
  const shapes={
    'a-prepare':[['prepared','localCommitUnpublished'],['probe']],
    'a-check':[['headUnchanged','branchUnchanged','indexUnchanged','statusUnchanged','filesUnchanged','stagedTrackedUnchanged','stagedNewUnchanged','remoteRefsUnchanged'],['probe']],
    'b-inspect':[inspect,inspectStatus],
    'b-publish':[[...inspect,'beforeABaseline','privateClone','testCommitTreeUnchanged','explicitPush'],[...inspectStatus,'clone','name','email','branch','beforeTree','commit','afterTree','push']],
    'observer-record':[['remoteRefsUnchanged','expectationsRecorded'],['remoteRefs','prInventory']],
    'observer-check':[['remoteRefsUnchanged','taskBranchPrInventoryUnchanged','observedAfterTerminal'],['remoteRefs','prInventory']],
    'asset-hashes':[['assetHashesMatch'],['hash']],
  };
  const shape=shapes[phase];if(!shape)throw new Error();
  const required=[...shape[0]];
  if(phase.startsWith('b-')&&Object.hasOwn(value.checks,'installedReleaseMatches'))required.push('installedReleaseMatches','installedBinaryMatches');
  if(!exact(value.checks,required)||!exact(value.statuses,shape[1]))throw new Error();
  return {checks:Object.fromEntries(Object.entries(value.checks)),statuses:Object.fromEntries(Object.entries(value.statuses))};
}
function entity(value,kind,privateState){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();
  // Only explicit scalar fields cross into the private state sink. No content/notes/labels/errors.
  const selected={};
  for(const key of ['id','taskId','workspaceId','nodeId','agentSessionId','evidenceId','status','taskStatus','activity','runtimeWorkState','runtimeWorkCount','activityAt','runtimeWorkUpdatedAt','runtimeWorkProgressAt','createdAt','completedAt','updatedAt']){
    if(value[key]!==undefined&&value[key]!==null)selected[key]=value[key];
  }
  // These are real task statuses missing from the generic boundary's small enum.
  const extraStatus=['delegated','blocked','awaiting_followup','stopping','error','destroying','provisioning','deleting','starting','restoring','recovery','evicted','deleted'];
  const status=selected.status;
  if(extraStatus.includes(status))delete selected.status;
  const result=privateState(selected);
  if(!result)throw new Error();
  if(extraStatus.includes(status))result.status=status;
  for(const key of ['sessionId','chatSessionId'])if(value[key]!==undefined&&value[key]!==null){if(!uuid(value[key]))throw new Error();result[key]=value[key];}
  for(const key of ['branchName','outputBranch'])if(value[key]!==undefined&&value[key]!==null){if(!branch(value[key]))throw new Error();result[key]=value[key];}
  if(value.agentType!==undefined&&value.agentType!==null){if(!['openai-codex','claude-code'].includes(value.agentType))throw new Error();result.agentType=value.agentType;}
  if(kind==='task'){
    result.completionEvidencePresent=!!value.completionEvidence&&typeof value.completionEvidence==='object';
    result.outputPrPresent=typeof value.outputPrUrl==='string'&&value.outputPrUrl.length>0;
  }
  return result;
}
function selector(path,method,project){
  const p=`/api/projects/${project}`;
  if(path===p+'/tasks/submit'&&method==='POST')return 'submit';
  if(new RegExp(`^${p}/tasks/[0-9A-HJKMNP-TV-Z]{26}$`,'u').test(path)&&method==='GET')return 'task';
  if(new RegExp(`^${p}/sessions/[0-9a-f-]{36}/state$`,'u').test(path)&&method==='GET')return 'state';
  if(new RegExp(`^${p}/sessions/[0-9a-f-]{36}/prompt$`,'u').test(path)&&method==='POST')return 'prompt';
  if(new RegExp(`^${p}/sessions/[0-9a-f-]{36}/stop$`,'u').test(path)&&method==='POST')return 'action';
  if(['/api/nodes','/api/workspaces'].includes(path)&&method==='GET')return 'list';
  if(/^\/api\/workspaces\/[0-9A-HJKMNP-TV-Z]{26}\/agent-sessions$/u.test(path)&&method==='GET')return 'list';
  if(/^\/api\/workspaces\/[0-9A-HJKMNP-TV-Z]{26}$/u.test(path)&&method==='GET')return 'workspace';
  if(/^\/api\/workspaces\/[0-9A-HJKMNP-TV-Z]{26}$/u.test(path)&&method==='DELETE')return 'action';
  if(/^\/api\/workspaces\/[0-9A-HJKMNP-TV-Z]{26}\/sleep$/u.test(path)&&method==='POST')return 'action';
  throw new Error();
}
const pause=()=>new Promise(r=>setTimeout(r,100));
export async function run({requestSafe,logoutSafe,screenshotSafe,summary,safeSummary,privateState}){
  let browser,context,finishLogout,final=summary('ok',0,true),loggedOut=false;
  try{
    const root=process.env.SAM_VERIFICATION_ROOT;
    const project=process.env.SAM_VERIFICATION_PROJECT_ID;
    const repository=process.env.SAM_VERIFICATION_REPOSITORY;
    const api=process.env.SAM_VERIFICATION_API_ORIGIN;
    const app=process.env.SAM_VERIFICATION_APP_ORIGIN;
    const duration=Number(process.env.SAM_VERIFICATION_DURATION_MS??3_000_000);
    const token=process.env.SAM_PLAYWRIGHT_PRIMARY_USER;
    if(!root||!isAbsolute(root)||!ulid(project)||typeof repository!=='string'||!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)
      ||!Number.isFinite(duration)||duration<=0||duration>3_300_000||typeof token!=='string'||!token||token.startsWith('__SAM_SECRET_'))return summary('configuration');
    for(const origin of [api,app]){const u=new URL(origin);if(u.protocol!=='https:'||u.origin!==origin)throw new Error();}
    for(const folder of ['in','out','private','private/state','private/artifacts'])await mkdir(join(root,folder),{recursive:true,mode:0o700});
    for(const folder of ['out','private/state','private/artifacts'])if((await readdir(join(root,folder))).length)throw new Error();
    await writeFile(join(root,'controller-started.json'),'{"started":true}',{flag:'wx',mode:0o600});
    const {chromium}=await import(process.env.SAM_VERIFICATION_PLAYWRIGHT_MODULE??'playwright');
    browser=await chromium.launch({headless:true});
    context=await browser.newContext({viewport:{width:1280,height:800}});
    const page=await context.newPage();
    finishLogout=async()=>{
      const out=await logoutSafe(context,api);if(out.category!=='ok')return out;
      const absent=await requestSafe(context,api,{path:'/api/auth/get-session'},value=>value===null);
      const protectedRead=await requestSafe(context,api,{path:'/api/nodes'});
      return absent.category==='ok'&&[401,403].includes(protectedRead.status)?summary('ok',out.status,true):summary('response',protectedRead.status);
    };
    const login=await requestSafe(context,api,{path:'/api/auth/token-login',method:'POST',data:{token}});
    delete process.env.SAM_PLAYWRIGHT_PRIMARY_USER;
    await writeFile(join(root,'ready.json'),JSON.stringify(safeSummary(login)),{mode:0o600});
    if(login.category!=='ok'){final=login;throw new Error();}
    const done=new Set(),idle=new Set(),sleeping=new Set(),submitted=new Map(),completed=new Set(),workspaces=new Map(),submittedAt=new Map();
    const end=Date.now()+duration;
    let stopping=false,failed=false;
    while(Date.now()<end&&!stopping){
      for(const name of (await readdir(join(root,'in'))).filter(n=>/^\d{4}\.json$/u.test(n)).sort()){
        if(done.has(name))continue;done.add(name);
        let result=summary('configuration');
        try{
          const text=await readFile(join(root,'in',name),'utf8');if(text.length>100_000)throw new Error();
          const cmd=JSON.parse(text);
          if(cmd.op==='stop'){stopping=true;result=summary('ok',0,true);}
          else if(cmd.op==='logout'){result=await finishLogout();if(result.category==='ok')loggedOut=true;}
          else if(cmd.op==='request'){
            const method=cmd.method??'GET';const type=selector(cmd.path,method,project);
            if(failed&&method!=='GET'&&method!=='DELETE'&&!(type==='action'&&cmd.path.endsWith('/stop')))throw new Error();
            if(type==='submit'){
              if(!exact(cmd.data,cmd.data?.workspaceProfile===undefined?['message','agentProfileId','taskMode']:['message','agentProfileId','taskMode','workspaceProfile'])
                ||!ulid(cmd.data.agentProfileId)||cmd.data.taskMode!=='task'||typeof cmd.data.message!=='string'||cmd.data.message.length>16000
                ||(cmd.data.workspaceProfile!==undefined&&cmd.data.workspaceProfile!=='lightweight'))throw new Error();
            }
            // Authorization derives only from this run's accepted submit -> canonical task -> workspace chain.
            // Inventory reads never grant mutation authority. Retain confirmed IDs for cleanup after sleep/stop.
            const target=cmd.path.split('/').at(-1),session=cmd.path.split('/').at(-2);
            if(type==='task'&&!submitted.has(target))throw new Error();
            if(type==='state'&&![...submitted.values()].includes(session))throw new Error();
            if(type==='workspace'&&!workspaces.has(target))throw new Error();
            if(type==='action'){
              if(cmd.path.endsWith('/stop')){if(![...submitted.values()].includes(session))throw new Error();}
              else if(cmd.path.endsWith('/sleep')){if(!workspaces.has(session))throw new Error();}
              else if(method==='DELETE'){
                if(!workspaces.has(target))throw new Error();
              }
            }
            if(type==='prompt'){
              const session=cmd.path.split('/').at(-2);
              if((!idle.has(session)&&!sleeping.has(session))||![...submitted.values()].includes(session)||!exact(cmd.data,['content'])||typeof cmd.data.content!=='string'||cmd.data.content.length>16000)throw new Error();
              idle.delete(session);sleeping.delete(session);
            }
            if(type==='state')idle.delete(cmd.path.split('/').at(-2));
            let selected;const requestStartedAt=Date.now();
            result=await requestSafe(context,api,cmd,json=>{
              if(type==='list'){if(!Array.isArray(json))throw new Error();selected=json.map(v=>entity(v,'item',privateState));}
              else if(type==='state'){
                if(!json||typeof json!=='object')throw new Error();
                const session=cmd.path.split('/').at(-2);
                selected={stateAvailable:json.state!==null&&json.state!==undefined};
                if(selected.stateAvailable){selected.state=entity(json.state,'state',privateState);if(json.agentSessionId!==null&&!agentIdentity(json.agentSessionId))throw new Error();if(json.agentSessionId!==null)selected.agentSessionId=json.agentSessionId;
                  if(agentIdentity(json.agentSessionId)&&selected.state.activity==='idle'&&selected.state.runtimeWorkState==='inactive'&&selected.state.runtimeWorkCount===0&&selected.state.activityAt>=submittedAt.get(session)&&selected.state.runtimeWorkUpdatedAt>=submittedAt.get(session)&&selected.state.activityAt<=Date.now()&&selected.state.runtimeWorkUpdatedAt<=Date.now())idle.add(session);else{idle.delete(session);sleeping.delete(session);}}
              }else if(type==='action'||type==='prompt'){
                selected={};
                if(!json||typeof json!=='object')throw new Error();
                if(['success','accepted','workspaceDeleted'].some(k=>json[k]===false))throw new Error();
                if(type==='prompt'){
                  if(json.accepted!==true||json.status!=='queued')throw new Error();
                }else if(method==='DELETE'){
                  if(json.success!==true||json.deletionStatus!=='confirmed')throw new Error();
                  selected.deletionConfirmed=true;
                }else if(cmd.path.endsWith('/stop')){
                  if(json.status!=='stopped'||json.workspaceDeleted!==true)throw new Error();
                }else if(cmd.path.endsWith('/sleep')){
                  if(json.status!=='sleeping'||!ulid(json.workspaceId)||!uuid(json.chatSessionId)||!when(json.snapshotExpiresAt)
                    ||json.workspaceId!==session||workspaces.get(session)!==json.chatSessionId)throw new Error();
                  sleeping.add(json.chatSessionId);
                  selected.snapshotExpiresAt=json.snapshotExpiresAt;
                }else throw new Error();
                for(const k of ['success','accepted','workspaceDeleted'])if(json[k]!==undefined){if(typeof json[k]!=='boolean')throw new Error();selected[k]=json[k];}
                if(json.status!==undefined)selected={...selected,...entity({status:json.status},'action',privateState)};
                if(json.id!==undefined)selected={...selected,...entity(json,'action',privateState)};
                if(!Object.keys(selected).length)throw new Error();
              }else{selected=entity(json,type,privateState);if(type==='submit'){
                  if(!ulid(selected.taskId)||!uuid(selected.sessionId)||selected.status!=='queued'||json.accepted===false||json.success===false)throw new Error();submitted.set(selected.taskId,selected.sessionId);submittedAt.set(selected.sessionId,requestStartedAt);
                }else if(type==='task'){
                  if(selected.id!==target)throw new Error();
                  if(selected.sessionId!==undefined&&selected.sessionId!==submitted.get(target))throw new Error();
                  if(selected.workspaceId!==undefined)workspaces.set(selected.workspaceId,submitted.get(target));
                  if(selected.status==='completed')completed.add(selected.id);
                }else if(type==='workspace'){
                  if(selected.id!==target)throw new Error();
                }}
              return true;
            });
            if(result.category==='ok')await writeFile(join(root,'private/state',name),JSON.stringify(selected),{mode:0o600});
          }else if(cmd.op==='artifact'){
            if(failed||!ulid(cmd.artifactId)||!ulid(cmd.taskId)||!branch(cmd.branch)||!['baseline','expectations','probe'].includes(cmd.schema))throw new Error();
            if(cmd.schema==='probe'&&!['a-prepare','a-check','b-inspect','b-publish','observer-record','observer-check','asset-hashes'].includes(cmd.probePhase))throw new Error();
            const destination=join(root,'private/artifacts',`${cmd.taskId}-${cmd.schema}${cmd.schema==='probe'?'-'+cmd.probePhase:''}.json`);
            result=await requestSafe(context,api,{path:`/api/projects/${project}/library/${cmd.artifactId}/download`},async value=>{
              let safe;
              if(cmd.schema==='probe')safe=probeArtifact(value,cmd.probePhase);
              else{
                const baseline=cmd.schema==='baseline'?baselineArtifact(value,cmd.branch):baselineArtifact(JSON.parse(await readFile(join(root,'private/artifacts',`${cmd.taskId}-baseline.json`),'utf8')),cmd.branch);
                safe=cmd.schema==='baseline'?baseline:expectationsArtifact(value,baseline,repository);
              }
              await writeFile(destination,JSON.stringify(safe),{mode:0o600});return true;
            });
          }else if(cmd.op==='screenshot'){
            // Disabled unless the coordinator approves the fresh completed-fixture summary surface.
            if(failed||process.env.SAM_VERIFICATION_SCREENSHOTS!=='completed-fixture-summary'||!completed.has(cmd.taskId)||!submitted.has(cmd.taskId))throw new Error();
            const path=`/projects/${project}/chat/${submitted.get(cmd.taskId)}`;
            const guarded={goto:async(url,options)=>{await page.goto(url,options);if(page.url()!==new URL(path,app).href)throw new Error();},screenshot:options=>page.screenshot(options)};
            const destination=join(root,'private/artifacts',`${cmd.taskId}-summary.png`);
            result=await screenshotSafe(guarded,app,path,destination);
            if(result.category!=='ok')await unlink(destination).catch(()=>{});
          }
        }catch{result=summary('controller');}
        result=safeSummary(result);
        await writeFile(join(root,'out',name),JSON.stringify(result),{mode:0o600});
        if(result.category!=='ok'){failed=true;final=result;}
        if(stopping)break;
      }
      if(!stopping)await pause();
    }
    if(!stopping&&final.category==='ok')final=summary('timeout');
  }catch{if(final.category==='ok')final=summary('controller');}
  finally{
    delete process.env.SAM_PLAYWRIGHT_PRIMARY_USER;
    if(context&&!loggedOut){try{const logout=await finishLogout();if(logout.category!=='ok')final=logout;}catch{final=summary('controller');}}
    if(browser){try{await browser.close();}catch{final=summary('controller');}}
  }
  return safeSummary(final);
}
