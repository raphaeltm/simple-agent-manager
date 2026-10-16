/** Verification only. No login, task creation, prompt, completion, Sleep or generic exec.
 * Full lifecycle is a reviewed ordered plan; caller supplies independently bound owner context.
 */
import {readFile,writeFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {browserTerminal} from './owner-terminal-inspect.mjs';
import {baselineArtifact,expectationsArtifact,probeArtifact} from './queue-controller.mjs';
export const project='01KJNR9R3TEN3KX1ETE33852R8',repository='serverspresentation2025/crewai';
export const version='b467f389811eadeaf973960bb30f9fa7b9cb4678';
export const assetHashes={'git-probe.py':'f061b7cd447cef55ceb08cb6a78fcb0b236ec3f347731e66d4b8447c224afa6c','b-probe.py':'889d7588ed44c8ab89e6ba7880ff20d81017f294bb7b31edfbc320ced064f509','terminal-observer.py':'d0970080ce89ab2810c0c9d758d1fc978efafe75fed91a4454f08639da88adff'};
const api='https://api.sammy.party',app='https://app.sammy.party';
const sha=b=>createHash('sha256').update(b).digest('hex');
const ulid=v=>typeof v==='string'&&/^[0-9A-HJKMNP-TV-Z]{26}$/.test(v);
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(v);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===keys.slice().sort().join();
export function identity(own){
 if(!exact(own,['taskId','sessionId','branch','agentProfileId','agentType','receipt'])||![own.taskId,own.agentProfileId].every(ulid)||!uuid(own.sessionId)
  ||!/^sam\/[a-z0-9][a-z0-9/-]{0,150}$/.test(own.branch)||!['claude-code','openai-codex'].includes(own.agentType)
  ||!exact(own.receipt,['taskId','sessionId','branchName','status'])||own.receipt.taskId!==own.taskId||own.receipt.sessionId!==own.sessionId
  ||own.receipt.branchName!==own.branch||own.receipt.status!=='queued')throw Error('binding');
 return own;
}
export function snapshotProof(v,own,workspaceId,since,hard,now,runtime='vm'){
 identity(own);
 if(!exact(v,['taskId','sessionId','workspaceId','snapshotId','status','runtime','degradation','expiresAt','snapshotGeneration','observedAt','sourceEvidenceSha256'])||v.taskId!==own.taskId||v.sessionId!==own.sessionId||v.workspaceId!==workspaceId||!ulid(v.snapshotId)||v.status!=='available'||!['vm','cf-container'].includes(runtime)||v.runtime!==runtime||v.degradation!=='none'||typeof v.snapshotGeneration!=='string'||!v.snapshotGeneration||v.snapshotGeneration.length>128||!Number.isFinite(Date.parse(v.expiresAt))||Date.parse(v.expiresAt)<=hard||!Number.isSafeInteger(v.observedAt)||v.observedAt<since||v.observedAt>now||!/^[0-9a-f]{64}$/.test(v.sourceEvidenceSha256))throw Error('snapshot');
 return v;
}
export function completionMessages(value,own,since,now){
 identity(own);
 if(!value||!Array.isArray(value.messages)||value.messages.length>100||typeof value.hasMore!=='boolean'||(value.skippedMessages!==undefined&&(!Number.isSafeInteger(value.skippedMessages)||value.skippedMessages<0)))throw Error('messages');
 const found=[];
 for(const row of value.messages){
  if(row?.sessionId!==own.sessionId||!Number.isSafeInteger(row.createdAt)||row.createdAt>now||row.createdAt<0)throw Error('messages');
  if(row.createdAt<since||row.role!=='tool')continue;
  if(!['mcp__sam_mcp__complete_task','mcp__sam-mcp__complete_task'].includes(row.toolMetadata?.toolName))continue;
  if(row.toolMetadata.status==='failed')throw Error('completion');
  if(row.toolMetadata.status==='completed'){
   if(typeof row.id!=='string'||!row.id||row.id.length>128)throw Error('message-id');
   found.push({id:row.id,sessionId:row.sessionId,createdAt:row.createdAt,role:'tool',toolMetadata:{toolName:row.toolMetadata.toolName,status:'completed'}});
  }
 }
 if(found.length!==1)throw Error('completion');
 return found[0];
}
export function completionProof(v,own,since,completedAt,now){
 identity(own);
 if(!exact(v,['taskId','sessionId','tool','status','createdAt','observedAt','originalEvidenceRetained','sourceEvidenceSha256','runtimeWorkTerminal'])||v.taskId!==own.taskId||v.sessionId!==own.sessionId||v.tool!=='mcp__sam_mcp__complete_task'||v.status!=='completed'||!Number.isSafeInteger(v.createdAt)||v.createdAt<since||v.createdAt>now||!Number.isSafeInteger(v.observedAt)||v.observedAt<Date.parse(completedAt)||v.observedAt>now||v.originalEvidenceRetained!==true||v.runtimeWorkTerminal!==true||!/^[0-9a-f]{64}$/.test(v.sourceEvidenceSha256))throw Error('completion');
 return v;
}
/** Immutable ordered evidence ledger. Missing stages cannot become PASS. */
export class AcceptanceSequence{
 constructor(own,started,hard){this.own=identity(own);if(!Number.isSafeInteger(started)||!Number.isSafeInteger(hard)||hard<=started||hard-started>2700000)throw Error('clock');this.started=started;this.hard=hard;this.events=[];}
 append(kind,proof,now){
  const order=['setup','turn','turn-check','sleep','wake','wake-check','complete','observe'];
  if(kind!==order[this.events.length]||now<this.started||now>=this.hard-120000||!Number.isSafeInteger(now)||(this.events.length&&now<this.events.at(-1).at)||!proof||proof.ok!==true)throw Error('sequence');
  if(kind==='setup'&&(!proof.baselineOriginal||!proof.expectationsOriginal||!proof.hostBytesRetained))throw Error('setup');
  if(['turn','wake'].includes(kind)&&(!proof.actualHarness||!proof.freshInactive||!proof.prompt202))throw Error('harness');
  if(kind==='sleep'&&(!proof.snapshotAvailable||!proof.sleep200||!proof.snapshotId))throw Error('sleep');
  if(kind==='complete'&&(!proof.actualTool||!Number.isFinite(Date.parse(proof.canonicalCompletedAt))||!proof.completionEvidence||Date.parse(proof.canonicalCompletedAt)<=this.events[0].at))throw Error('completion');
  if(kind==='observe'&&(!proof.independentRuntime||!proof.originalBaseline||!proof.originalExpectations||!proof.afterCanonical||!proof.allRefsAllPrStates))throw Error('observer');
  this.events.push(Object.freeze({kind,at:now,proof:Object.freeze({...proof})}));return this;
 }
 get pass(){return this.events.length===8;}
}
export async function capsule(own,operation,originals={},runId=randomUUID()){
 identity(own);if(!['setup','check','observe'].includes(operation)||!uuid(runId))throw Error('configuration');
 const assets={};for(const [name,digest]of Object.entries(assetHashes)){const b=await readFile(new URL(name,import.meta.url));if(sha(b)!==digest)throw Error('assets');assets[name]=b.toString('base64');}
 if(operation!=='setup'){
  const baseline=baselineArtifact(JSON.parse(originals.baseline),own.branch);
  expectationsArtifact(JSON.parse(originals.expectations),baseline,repository);
  if(operation==='observe'&&(!Number.isFinite(Date.parse(originals.completedAt))||Date.parse(originals.completedAt)<=Date.parse(JSON.parse(originals.expectations).recordedAt)))throw Error('completion');
 }
 const config={taskId:own.taskId,sessionId:own.sessionId,branch:own.branch,runId,operation,assets,
  baseline:operation==='setup'?null:Buffer.from(originals.baseline).toString('base64'),expectations:operation==='setup'?null:Buffer.from(originals.expectations).toString('base64'),completedAt:operation==='observe'?originals.completedAt:null};
 const script=await readFile(new URL('prospective-capsule.py',import.meta.url));
 const bytes=Buffer.from(JSON.stringify({script:script.toString('base64'),config}));
 const payload=gzipSync(bytes).toString('base64'),directory=`/workspaces/reliability-prospective/${own.taskId}/${runId}`;
 // Only base64 enters shell literals. Every canonical input line remains below 3800 bytes.
 const bootstrap=`import pathlib,sys; p=pathlib.Path('${directory}'); assert not any(x.is_symlink() for x in [p,*p.parents]); p.mkdir(parents=True,exist_ok=False,mode=448)`;
 const execute=`import pathlib,base64,gzip,hashlib,json,sys; p=pathlib.Path('${directory}'); b=gzip.decompress(base64.b64decode((p/'payload').read_bytes())); assert hashlib.sha256(b).hexdigest()=='${sha(bytes)}'; v=json.loads(b); f=(p/'config.json').open('x'); json.dump(v['config'],f); f.close(); (p/'config.json').chmod(384); sys.argv=['fixed-capsule',str(p)]; exec(compile(base64.b64decode(v['script']),'fixed-capsule','exec'))`;
 const lines=[`sam_reliability_python=''; for p in /opt/uv-python/*/bin/python3 /usr/bin/python3 /usr/local/bin/python3; do if [ -x "$p" ] && "$p" -c 'import sys;assert sys.executable.startswith("/")' >/dev/null 2>&1; then sam_reliability_python="$p"; break; fi; done`,
  `if [ -n "$sam_reliability_python" ] && "$sam_reliability_python" -c "${bootstrap}"; then`];
 for(let i=0;i<payload.length;i+=2400)lines.push(`printf '%s' '${payload.slice(i,i+2400)}' >> '${directory}/payload'`);
 lines.push(`"$sam_reliability_python" -c "${execute}"`, 'fi');
 if(lines.some(line=>Buffer.byteLength(line)>3800))throw Error('line');
 return {runId,directory,command:'{\n'+lines.join('\n')+'\n} >/dev/null 2>&1\n',config,script,packageSha256:sha(bytes)};
}

/** Exact owner+independent stored-ID grant. Baseline target for observe is separately canonical completed. */
export async function terminalPhase({own,operation,originals,context,page,grant,evidenceDirectory,open=browserTerminal,now=Date.now,pause=ms=>new Promise(r=>setTimeout(r,ms))}){
 identity(own);let terminal,created=false,token;const started=now(),deadline=started+90000;
 const out={ok:false,stage:'binding',before:false,after:false,manifest:false,hostBytesRetained:false,terminalClosed:false,socketClosed:false,quiescence:false};
 const live=()=>{if(now()>=deadline)throw Error('deadline');};
 const get=async(path,method='GET',data)=>{live();const r=await context.request.fetch(api+path,{method,data,headers:{Origin:app},timeout:5000,maxRedirects:0,failOnStatusCode:false});try{if(r.status()!==200)throw 0;const b=await r.body();if(b.length>250000)throw 0;return JSON.parse(b);}finally{await r.dispose();}};
 const bind=async()=>{
  if(!grant||!Number.isSafeInteger(grant.globalVmCount)||grant.globalVmCount<0||grant.globalVmCount>1||(grant.runtime==='vm'&&grant.globalVmCount!==1)||grant.otherWorkspaceCount!==0||grant.activeForeignClaimCount!==0||!ulid(grant.workspaceId)||!ulid(grant.nodeId)||!(ulid(grant.agentSessionId)||uuid(grant.agentSessionId))||grant.expiresAt<=now()||grant.expiresAt>now()+300000||grant.storedProfileId!==own.agentProfileId||grant.storedProfileObservedAt>now()||grant.storedProfileObservedAt<now()-240000||!['vm','cf-container'].includes(grant.runtime)||(grant.runtime==='vm'&&grant.agentVersion!==version))throw 0;
  if(JSON.stringify(grant.receipt)!==JSON.stringify(own.receipt))throw 0;
  const u=await get('/api/auth/get-session'),p=await get(`/api/projects/${project}/agent-profiles/${own.agentProfileId}`),list=await get(`/api/projects/${project}/agent-profiles`);
  if(u?.user?.id!==grant.ownerId||p?.id!==own.agentProfileId||p.userId!==grant.expectedProfileOwnerId||p.agentType!==own.agentType||p.vmSizeOverride!=null||!(p.runtime===null||p.runtime===grant.runtime)||!(p.projectId===project||(p.projectId===null&&p.userId===grant.ownerId))||!Array.isArray(list.items)||list.items.filter(x=>x.name===p.name).length!==1)throw 0;
  const t=await get(`/api/projects/${project}/tasks/${own.taskId}`),s=await get(`/api/projects/${project}/sessions/${own.sessionId}?limit=1`),w=await get('/api/workspaces/'+grant.workspaceId),a=await get(`/api/projects/${project}/sessions/${own.sessionId}/state`);
  if(t.id!==own.taskId||t.userId!==grant.ownerId||t.projectId!==project||t.outputBranch!==own.branch||t.workspaceId!==grant.workspaceId||t.agentProfileHint!==(p.userId===grant.ownerId?p.name:p.id)||!['in_progress','completed'].includes(t.status)||s.session?.taskId!==own.taskId||s.session.id!==own.sessionId||s.session.workspaceId!==w.id||s.session.agentSessionId!==grant.agentSessionId||s.session.agentType!==own.agentType||w.id!==grant.workspaceId||w.nodeId!==grant.nodeId||w.projectId!==project||w.chatSessionId!==own.sessionId||w.branch!==own.branch||w.repository!==repository||w.status!=='running'||w.hardware?.cloudProvider!==(grant.runtime==='vm'?'hetzner':'cloudflare')||a.agentSessionId!==grant.agentSessionId||a.agentType!==own.agentType||a.state?.activity!=='idle'||a.state.runtimeWorkState!=='inactive'||a.state.runtimeWorkCount!==0||![a.state.activityAt,a.state.runtimeWorkUpdatedAt].every(v=>Number.isSafeInteger(v)&&v>=started-60000&&v<=now()))throw 0;
  return `https://ws-${w.id}.sammy.party`;
 };
 const wait=async(key,until)=>{while(now()<until){const s=await terminal.state();if(s.failed)throw 0;if(s[key])return;await pause(100);}throw 0;};
 try{
  const checkTarget=async()=>{if(operation==='observe'){identity(originals.target);const target=await get(`/api/projects/${project}/tasks/${originals.target.taskId}`);if(target.id!==originals.target.taskId||target.projectId!==project||target.userId!==grant.ownerId||target.outputBranch!==originals.target.branch||target.status!=='completed'||target.completedAt!==originals.completedAt||!target.completionEvidence||typeof target.completionEvidence!=='object'||Date.parse(target.completedAt)>now())throw 0;return {taskId:target.id,branch:target.outputBranch,completedAt:target.completedAt,completionEvidenceSha256:sha(JSON.stringify(target.completionEvidence))};}return null;};
  const url=await bind();out.before=true;const targetBefore=await checkTarget();
 const bundle=await capsule(operation==='observe'?originals.target:own,operation,originals);out.runId=bundle.runId;
  const access=await get('/api/terminal/token','POST',{workspaceId:grant.workspaceId});
  if(access.workspaceUrl!==url||typeof access.token!=='string'||access.token.length<32||access.token.length>16000||!Number.isFinite(Date.parse(access.expiresAt))||Date.parse(access.expiresAt)<=now())throw 0;
  token=access.token;out.stage='terminal';terminal=await open(page,url.replace('https:','wss:')+'/terminal/ws/multi?token='+encodeURIComponent(token),bundle.runId);
  await terminal.send({type:'create_session',data:{sessionId:bundle.runId,rows:24,cols:80,name:'prospective verification'}});created=true;await wait('created',Math.min(deadline,now()+5000));
  await terminal.send({type:'input',sessionId:bundle.runId,data:{data:bundle.command}});
  const download=async name=>{live();const r=await context.request.fetch(url+`/workspaces/${grant.workspaceId}/files/download?path=`+encodeURIComponent(bundle.directory+'/'+name)+'&token='+encodeURIComponent(token),{headers:{Origin:app},timeout:5000,maxRedirects:0,failOnStatusCode:false});try{if(r.status()===404)return null;if(r.status()!==200)throw 0;const b=await r.body(),n=(await r.headers())['content-length'];if(b.length>131072||(n!==undefined&&(!/^\d+$/.test(n)||Number(n)!==b.length)))throw 0;return b;}finally{await r.dispose();}};
  let raw;while(now()<deadline-15000){raw=await download('done.json');if(raw)break;await pause(1000);}if(!raw)throw 0;
  out.stage='capsule-result';const done=JSON.parse(raw);if(!exact(done,['taskId','sessionId','runId','operation','status','files'])||done.taskId!==bundle.config.taskId||done.sessionId!==bundle.config.sessionId||done.runId!==bundle.runId||done.operation!==operation||![0,1].includes(done.status))throw 0;
  if(done.status===1){if(!exact(done.files,[]))throw 0;await writeFile(evidenceDirectory+'/done.json',raw,{mode:0o600,flag:'wx'});out.capsuleStatus=1;throw 0;}
  const names=operation==='setup'?['runtime.json','prepare.json','baseline.json','check.json','record.json','expectations.json']:operation==='check'?['runtime.json','check.json','publication.json']:['observer.json'];
  if(!exact(done.files,names)||Object.values(done.files).some(v=>!/^[0-9a-f]{64}$/.test(v)))throw 0;
  const bytes={};for(const name of names){const b=await download(name);if(!b||sha(b)!==done.files[name])throw 0;bytes[name]=b;}
  const target=operation==='observe'?originals.target:own;
  const probePass=(b,phase)=>{const v=probeArtifact(JSON.parse(b),phase);if(!Object.values(v.checks).every(x=>x===true)||!Object.values(v.statuses).every(x=>x===0))throw 0;};
  if(operation!=='observe'){const r=JSON.parse(bytes['runtime.json']);if(!exact(r,['checks','statuses'])||!exact(r.checks,['installedReleaseMatches','installedBinaryMatches'])||!exact(r.statuses,['proof'])||r.checks.installedReleaseMatches!==true||r.checks.installedBinaryMatches!==true||r.statuses.proof!==0)throw 0;}
  if(operation==='setup'){
   const baseline=baselineArtifact(JSON.parse(bytes['baseline.json']),target.branch);expectationsArtifact(JSON.parse(bytes['expectations.json']),baseline,repository);
   probePass(bytes['prepare.json'],'a-prepare');probePass(bytes['record.json'],'observer-record');
  }
  if(operation==='observe')probePass(bytes['observer.json'],'observer-check');else probePass(bytes['check.json'],'a-check');
  if(operation==='check'){const p=JSON.parse(bytes['publication.json']);if(!exact(p,['checks','statuses'])||!exact(p.checks,['remoteRefsUnchanged','taskBranchPrInventoryUnchanged'])||!exact(p.statuses,['remoteRefs','prInventory'])||!Object.values(p.checks).every(v=>v===true)||!Object.values(p.statuses).every(v=>v===0))throw 0;}
  // Preserve ORIGINAL manifest and every downloaded ORIGINAL byte before any next phase.
  await writeFile(evidenceDirectory+'/done.json',raw,{mode:0o600,flag:'wx'});
  for(const [name,b]of Object.entries(bytes))await writeFile(evidenceDirectory+'/'+name,b,{mode:0o600,flag:'wx'});
  out.manifest=true;out.hostBytesRetained=true;out.sourceManifestSha256=sha(raw);out.stage='canonical-after';await bind();const targetAfter=await checkTarget();if(operation==='observe'){if(JSON.stringify(targetAfter)!==JSON.stringify(targetBefore))throw 0;await writeFile(evidenceDirectory+'/target-terminal.json',JSON.stringify({before:targetBefore,after:targetAfter}),{mode:0o600,flag:'wx'});}out.after=true;
 }catch{}finally{
  if(terminal)try{if(created){await terminal.send({type:'close_session',data:{sessionId:out.runId}});await wait('closed',Math.min(deadline,now()+5000));out.terminalClosed=true;}}catch{}
  if(terminal)try{await terminal.dispose();out.socketClosed=true;}catch{}
 }
 out.quiescence=out.before&&out.after&&out.manifest&&out.hostBytesRetained&&out.terminalClosed&&out.socketClosed;out.ok=out.quiescence;return out;
}
