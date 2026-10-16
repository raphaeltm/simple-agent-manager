import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {inspectOwnedFixture,inspectionCommand,browserTerminal} from './owner-terminal-inspect.mjs';
const task='01M51CCMB1S684RXVNBNDQRDAS',session='1135ad88-96dd-4ec2-a1d1-5813d295d2a5',project='01KJNR9R3TEN3KX1ETE33852R8';
const branch='sam/authorized-one-required-reliability-dqrdas',profile='01KRS7Z2R88JFC73ARA7DV9WTK',workspaceId='01M51CJ70CX1ZYQ3M8TDVGM885',nodeId='01M51CCV9A1D2BDK4NJDK1E3MC';
const canary='PRIVATE_CANARY_DO_NOT_EMIT',now=Date.now();
const agentSessionId='01M51CP7439Z7BS26T7MZ2PDZ6';
const grant={workspaceId,nodeId,ownerId:'owner',expectedProfileOwnerId:'owner',agentSessionId,runtime:'vm',agentVersion:'b467f389811eadeaf973960bb30f9fa7b9cb4678',expiresAt:now+120000,storedProfileId:profile,storedProfileObservedAt:now,receipt:{taskId:task,sessionId:session,branchName:branch,status:'queued'}};
const state={checks:Object.fromEntries(['repositoryRoot','branchMatches','fixtureDirectory','baselineFile','expectationsFile','gitProbeHash','bProbeHash','observerHash'].map(k=>[k,true])),statuses:{gitRoot:0,gitBranch:0}};
const bytes=Buffer.from(JSON.stringify(state)),digest=createHash('sha256').update(bytes).digest('hex');
async function scenario(mode){
 let clock=now,id,closed=false,disposed=false,reads=0,input=false;const frames=[];
 const context={request:{fetch:async(url,options)=>{
  reads++;assert.equal(options.maxRedirects,0);assert.equal(options.headers.Origin,'https://app.sammy.party');
  let v,status=200;
  if(url.endsWith('/get-session'))v={user:{id:mode==='foreign-owner'?canary:'owner'}};
  else if(url.includes('/agent-profiles/'))v={id:profile,userId:['foreign-profile-owner','project-shared-owner','global-foreign-owner'].includes(mode)?'foreign':'owner',name:canary,agentType:'claude-code',runtime:'vm',projectId:mode==='global-foreign-owner'?null:project};
  else if(url.endsWith('/agent-profiles'))v={items:[{id:profile,name:canary},...(mode==='profile-collision'?[{id:nodeId,name:canary}]:[])]};
  else if(url.includes('/tasks/'))v={id:task,projectId:project,userId:'owner',chatSessionId:session,outputBranch:branch,workspaceId,agentProfileHint:canary,status:'in_progress'};
  else if(url.endsWith('/state'))v={agentSessionId:mode==='wrong-acp'?nodeId:agentSessionId,agentType:'claude-code'};
  else if(url.includes('/sessions/'))v={session:{id:session,taskId:task,workspaceId,agentType:'claude-code',agentSessionId}};
  else if(url.endsWith('/api/workspaces/'+workspaceId))v={id:workspaceId,nodeId:mode==='foreign-node'?'01M51CCV9A1D2BDK4NJDK1E3MD':nodeId,projectId:project,chatSessionId:session,branch,repository:'serverspresentation2025/crewai',status:'running',hardware:{cloudProvider:'hetzner'}};
  else if(url.endsWith('/terminal/token')){assert.deepEqual(options.data,{workspaceId});v={token:canary.repeat(3),expiresAt:new Date(now+300000).toISOString(),workspaceUrl:`https://ws-${workspaceId}.sammy.party`};}
  else if(url.includes('/files/download?')){
   assert(input);assert(url.includes('token='+encodeURIComponent(canary.repeat(3))));
   if(['timeout','action-deadline'].includes(mode)){status=404;v={};if(mode==='action-deadline')clock=now+60001;}
   else if(decodeURIComponent(url).includes('/done.json'))v={taskId:task,sessionId:session,runId:id,operation:'read-state',status:0,stateSha256:mode==='bad-manifest'?'0'.repeat(64):digest};
   else v=state;
  }else throw new Error(canary);
  const body=Buffer.from(JSON.stringify(v));return {status:()=>status,body:async()=>body,headers:async()=>mode==='missing-length'?{}:{'content-length':mode==='bad-length'?'bad':String(body.length)},dispose:async()=>{}};
 }}};
 const open=async(_page,url,runId)=>{id=runId;assert(url.startsWith(`wss://ws-${workspaceId}.sammy.party/terminal/ws/multi?token=`));return {
  send:async f=>{frames.push(f);if(f.type==='input'){assert(f.data.data.length<3800);assert(!f.data.data.includes(canary));input=true;}if(f.type==='close_session')closed=true;},
  state:async()=>({created:true,closed:closed&&mode!=='wrong-close',failed:false}),dispose:async()=>{disposed=true;if(mode==='dispose-failure')throw new Error(canary);},
 };};
 const g=structuredClone(grant);if(mode==='wrong-receipt')g.receipt.taskId=nodeId;if(['project-shared-owner','global-foreign-owner'].includes(mode))g.expectedProfileOwnerId='foreign';
 const r=await inspectOwnedFixture({context,page:{},grant:g,open,now:()=>clock,pause:async ms=>{clock+=ms;}});
 assert(!JSON.stringify(r).includes(canary));
 if(['success','project-shared-owner','missing-length'].includes(mode)){assert(r.ok&&r.quiescence&&r.terminalClosed);assert.deepEqual(frames.map(f=>f.type),['create_session','input','close_session']);assert.equal(frames[0].data.workDir,undefined);assert.deepEqual(r.state,state);}
 else {assert.equal(r.ok,false);assert.equal(r.quiescence,false);}
 if(['success','project-shared-owner','missing-length','bad-length','bad-manifest','timeout','action-deadline','wrong-close','dispose-failure'].includes(mode))assert(closed&&disposed);
 else assert.equal(frames.length,0);
 if(mode==='wrong-receipt')assert.equal(reads,0);
 if(mode==='action-deadline'){assert.equal(r.terminalClosed,true);assert.equal(r.quiescence,false);}
}
for(const mode of ['success','project-shared-owner','global-foreign-owner','missing-length','bad-length','foreign-owner','foreign-profile-owner','foreign-node','wrong-receipt','profile-collision','wrong-acp','bad-manifest','timeout','action-deadline','wrong-close','dispose-failure'])await scenario(mode);

// Exercise the actual browser transport parser with arbitrary PTY canary, not a replacement parser.
const original=globalThis.WebSocket;
globalThis.WebSocket=class{
 constructor(){queueMicrotask(()=>this.onopen());}
 send(data){const f=JSON.parse(data);this.onmessage({data:JSON.stringify({type:'output',data:{data:canary}})});if(f.type==='create_session')this.onmessage({data:JSON.stringify({type:'session_created',sessionId:f.data.sessionId,data:{sessionId:f.data.sessionId}})});if(f.type==='close_session')this.onmessage({data:JSON.stringify({type:'session_closed',sessionId:f.data.sessionId,data:{sessionId:f.data.sessionId,reason:'user_requested'}})});}
 close(){}
};
try{
 const page={url:()=> 'https://app.sammy.party/projects/example',evaluate:async(fn,arg)=>fn(arg)};
 const id='11111111-1111-4111-8111-111111111111',t=await browserTerminal(page,'wss://example.invalid/?token='+canary,id);
 await t.send({type:'create_session',data:{sessionId:id}});await t.send({type:'close_session',data:{sessionId:id}});
 assert.deepEqual(await t.state(),{created:true,closed:true,failed:false});assert(!JSON.stringify(await t.state()).includes(canary));await t.dispose();assert(!globalThis.__reliabilityOwnedTerminal);
 await assert.rejects(browserTerminal({...page,url:()=> 'https://foreign.invalid'},'wss://example.invalid',id));
 const command=inspectionCommand(id);assert(Buffer.byteLength(command.command)<3800);assert(!command.command.includes(canary));
}finally{globalThis.WebSocket=original;}
console.log(JSON.stringify({protocolAndPrivacy:true,cases:18,liveCalls:0}));
