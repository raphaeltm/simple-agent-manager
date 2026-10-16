/** One focused terminal-failure regression: all HTTP/socket boundaries simulated. */
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {terminalPhase,project,repository} from './prospective-vm.mjs';
const root=await mkdtemp(join(tmpdir(),'sam-terminal-diag-')),old=process.env.SAM_PROSPECTIVE_ROOT;
const canary='PRIVATE_URL_TOKEN_ERROR_CANARY',own={taskId:'01M51ZZZZZZZZZZZZZZZZZZZZZ',sessionId:'11111111-2222-4333-8444-555555555555',branch:'sam/prospective-codex',agentProfileId:'01KXG9MJRZ36FFJX0RVNW67SWB',agentType:'openai-codex'};
own.receipt={taskId:own.taskId,sessionId:own.sessionId,branchName:own.branch,status:'queued'};
const workspaceId='01M51YYYYYYYYYYYYYYYYYYYYY',nodeId='01M51XXXXXXXXXXXXXXXXXXXXX',agentSessionId='01M51AAAAAAAAAAAAAAAAAAAAA';
try{
 const provenance={apiSource:'a'.repeat(40),agentSource:'b'.repeat(40),publishedBinarySha256:'c'.repeat(64),rawHostShaObserved:false};process.env.SAM_PROSPECTIVE_ROOT=root;
 await writeFile(join(root,'release-pin.json'),JSON.stringify({...provenance,capacityPoolRevision:73}));
 const grant={...{workspaceId,nodeId,agentSessionId},ownerId:'owner',expectedProfileOwnerId:'owner',runtime:'vm',agentVersion:provenance.agentSource,capacityPoolRevision:73,releaseProvenance:provenance,globalVmCount:1,otherWorkspaceCount:0,activeForeignClaimCount:0,storedProfileId:own.agentProfileId,storedProfileObservedAt:Date.now(),expiresAt:Date.now()+200000,receipt:own.receipt};
 const profile={id:own.agentProfileId,userId:'owner',projectId:project,name:'fixture',agentType:own.agentType,runtime:'vm',vmSizeOverride:null};
 const response=(v,status=200)=>({status:()=>status,body:async()=>Buffer.from(JSON.stringify(v)),dispose:async()=>{}});
 let scenario='http',closed=false,disposed=false,clock=Date.now();
 const context={request:{fetch:async url=>{
  if(url.includes('/files/download?')){if(scenario==='timeout')throw Object.assign(new Error(canary),{name:'TimeoutError'});return response({},503);}
  if(url.endsWith('/api/auth/get-session'))return response({user:{id:'owner'}});
  if(url.includes('/agent-profiles/'))return response(profile);if(url.endsWith('/agent-profiles'))return response({items:[profile]});
  if(url.includes('/tasks/'))return response({id:own.taskId,userId:'owner',projectId:project,outputBranch:own.branch,workspaceId,agentProfileHint:'fixture',status:'in_progress'});
  if(url.endsWith('/state'))return response({agentSessionId,agentType:own.agentType,state:{activity:'idle',runtimeWorkState:'inactive',runtimeWorkCount:0,activityAt:clock,runtimeWorkUpdatedAt:clock}});
  if(url.includes('/sessions/'))return response({session:{id:own.sessionId,taskId:own.taskId,workspaceId,agentSessionId,agentType:own.agentType}});
  if(url.includes('/api/workspaces/'))return response({id:workspaceId,nodeId,projectId:project,chatSessionId:own.sessionId,branch:own.branch,repository,status:'running',hardware:{cloudProvider:'hetzner'}});
  if(url.endsWith('/api/terminal/token'))return response({workspaceUrl:`https://ws-${workspaceId}.sammy.party`,token:canary.repeat(3),expiresAt:new Date(clock+200000).toISOString()});throw Error(canary);
 }}};
 const open=async()=>({send:async f=>{if(f.type==='close_session')closed=true;},state:async()=>({created:scenario!=='create-timeout',closed,failed:scenario==='terminal-failed'&&!closed}),dispose:async()=>{disposed=true;}});
 for(scenario of ['http','timeout','terminal-failed','create-timeout']){
  closed=false;disposed=false;clock=Date.now();
  const out=await terminalPhase({own,operation:'setup',originals:{},context,page:{},grant,evidenceDirectory:root,open,now:()=>clock,pause:async ms=>{clock+=ms;}});
  assert.equal(out.ok,false);assert.equal(out.manifest,false);assert.equal(out.hostBytesRetained,false);assert.equal(out.terminalClosed,true);assert.equal(out.socketClosed,true);assert(closed&&disposed);assert(!JSON.stringify(out).includes(canary));
  assert.deepEqual(out.diagnostics,{checkpoint:scenario==='http'||scenario==='timeout'?'download':'create-wait',createAck:scenario==='http'||scenario==='timeout',commandSent:scenario==='http'||scenario==='timeout',downloadAttempts:scenario==='http'||scenario==='timeout'?1:0,lastDownloadHttp:scenario==='http'?503:0,timeout:scenario==='timeout'||scenario==='create-timeout',terminalFailed:scenario==='terminal-failed'});
 }
 console.log(JSON.stringify({ok:true,focusedRegression:1,failureSubcases:4,liveCalls:0,rawDiagnosticsSuppressed:true}));
}finally{if(old===undefined)delete process.env.SAM_PROSPECTIVE_ROOT;else process.env.SAM_PROSPECTIVE_ROOT=old;await rm(root,{recursive:true,force:true});}
