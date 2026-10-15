// Verification only. Fixed existing replacement session; safe-controller.mjs ONLY.
import {writeFile} from 'node:fs/promises';
const api='https://api.sammy.party',project='01KJNR9R3TEN3KX1ETE33852R8';
const task='01M50WGVQRS08BCA1SEDEZNG0V',session='8898726c-23b7-4546-b6d8-ae4c7f707e6d';
const workspace='01M50WGXPZESSX4D37TQ5DDJCW',branch='sam/authorized-minimal-instant-claude-ezng0v';
const profile='01KYQ60N603GE9G3Y767K9NSW4';
const base=`/api/projects/${project}/sessions/${session}`;
const roles=['user','assistant','thinking','plan','tool'];
const tools=['Bash','Read','Write','Edit','mcp__sam-mcp__get_instructions','mcp__sam-mcp__upload_to_library','mcp__sam_mcp__get_instructions','mcp__sam_mcp__upload_to_library'];
const statuses=['pending','in_progress','completed','failed'];
const kinds=['permission','form','url'];
const states=['pending','answered','delivery_confirmed','delivery_unconfirmed','interrupted','expired','cancelled'];
const countKeys=keys=>Object.fromEntries([...keys,'unknown'].map(x=>[x,0]));
const bucket=(keys,value)=>keys.includes(value)?value:'unknown';
const time=(value,now)=>Number.isSafeInteger(value)&&value>=0&&value<=now;
export function projectMessages(value,now){
 if(!value||!Array.isArray(value.messages)||value.messages.length>100||typeof value.hasMore!=='boolean'
  ||!(value.skippedMessages===undefined||(Number.isSafeInteger(value.skippedMessages)&&value.skippedMessages>=0)))return null;
 const counts=countKeys(roles),observations=[];let missingToolName=0;
 for(const row of value.messages){
  if(!row||row.sessionId!==session||!time(row.createdAt,now))return null;
  const role=bucket(roles,row.role);counts[role]++;
  if(role==='tool'){
   const meta=row.toolMetadata;
   if(!meta||typeof meta.toolName!=='string')missingToolName++;
   observations.push({at:row.createdAt,tool:bucket(tools,meta?.toolName),status:bucket(statuses,meta?.status)});
  }
 }
 const times=value.messages.map(row=>row.createdAt);
 return {count:value.messages.length,roles:counts,hasMore:value.hasMore,skippedMessages:value.skippedMessages??0,
  complete:!value.hasMore&&!(value.skippedMessages>0),oldestAt:times.length?Math.min(...times):null,
  newestAt:times.length?Math.max(...times):null,missingToolName,tools:observations};
}
export function projectInteractions(value,now){
 if(!value||!Array.isArray(value.pending)||!Array.isArray(value.settled)||value.pending.length>100||value.settled.length>100)return null;
 const result={pending:{count:0,kinds:countKeys(kinds),states:countKeys(states)},settled:{count:0,kinds:countKeys(kinds),states:countKeys(states)},times:[]};
 for(const group of ['pending','settled'])for(const row of value[group]){
  if(!row||!time(row.createdAt,now)||!time(row.deadlineAt,Number.MAX_SAFE_INTEGER))return null;
  const entry={createdAt:row.createdAt,deadlineAt:row.deadlineAt};
  for(const key of ['updatedAt','answeredAt','urlCompletedAt']){
   if(row[key]!==undefined&&row[key]!==null){if(!time(row[key],now))return null;entry[key]=row[key];}
  }
  result[group].count++;result[group].kinds[bucket(kinds,row.kind)]++;result[group].states[bucket(states,row.state)]++;result.times.push(entry);
 }
 // Cursor is never persisted; a nonempty/unknown cursor means a bounded snapshot.
 result.complete=value.cursor===null;return result;
}
export async function run({requestSafe,logoutSafe,summary,safeSummary}){
 let browser,context,projection=null,loggedOut=false,stage='login',failedStage=null;
 const stages=['login','canonical-before','messages','interactions','canonical-after','projection','logout','nullsession','protecteddenial','browserclosed'];
 const checkpoints=Object.fromEntries(stages.map(key=>[key,false]));
 const httpStatuses=Object.fromEntries(stages.map(key=>[key,0]));
 const status=value=>Number.isInteger(value)&&value>=100&&value<=599?value:0;
 const failed=()=>{if(failedStage===null)failedStage=stage;};
 try{
  const token=process.env.SAM_PLAYWRIGHT_PRIMARY_USER;
  if(typeof token!=='string'||!token||token.startsWith('__SAM_SECRET_'))return summary('configuration');
  const {chromium}=await import('/tmp/reliability-browser-deps/node_modules/playwright/index.mjs');
  browser=await chromium.launch({headless:true});context=await browser.newContext();
  const request=async(path,accept,options={})=>{
   const r=await requestSafe(context,api,{path,timeoutMs:10_000,...options},accept);httpStatuses[stage]=status(r.status);if(r.category!=='ok')throw new Error();
  };
  await request('/api/auth/token-login',undefined,{method:'POST',data:{token}});delete process.env.SAM_PLAYWRIGHT_PRIMARY_USER;checkpoints.login=true;
  // The existing supervisor rejects query-bearing paths. This closed two-value reader
  // preserves its Origin, no-redirect, timeout, dispose and no-raw-error guarantees.
  const fixedRead=async(kind,accept)=>{
   const path=kind==='binding'?base+'?limit=1':kind==='messages'?base+'/messages?limit=100&order=desc&compact=true':null;
   if(!path)throw new Error();
   const response=await context.request.fetch(api+path,{method:'GET',headers:{Origin:api},timeout:10_000,maxRedirects:0,failOnStatusCode:false});
   try{httpStatuses[stage]=status(response.status());if(response.status()!==200||!accept(await response.json()))throw new Error();}finally{try{await response.dispose();}catch{}}
  };
  const bind=async()=>{
   await request(`/api/projects/${project}/tasks/${task}`,v=>v?.id===task&&v.projectId===project&&v.workspaceId===workspace
    &&v.outputBranch===branch&&v.taskMode==='task'&&v.agentProfileHint===profile&&v.status==='in_progress');
   await fixedRead('binding',v=>v?.session?.id===session&&v.session.taskId===task&&v.session.workspaceId===workspace
    &&v.session.task?.id===task&&v.session.task.outputBranch===branch);
  };
  stage='canonical-before';await bind();checkpoints[stage]=true;const readAt=Date.now();let messages,interactions;
  stage='messages';
  await fixedRead('messages',v=>{messages=projectMessages(v,Date.now());return messages!==null;});checkpoints[stage]=true;
  stage='interactions';
  await request(base+'/interactions',v=>{interactions=projectInteractions(v,Date.now());return interactions!==null;});checkpoints[stage]=true;
  stage='canonical-after';await bind();checkpoints[stage]=true;
  projection={taskId:task,sessionId:session,projectId:project,readAt,messages,interactions,
   retentionVerified:false,underlyingCause:'unknown',noExecutionProven:false};
 }catch{failed();projection=null;}
 finally{
  delete process.env.SAM_PLAYWRIGHT_PRIMARY_USER;
  if(context){
   stage='logout';try{const out=await logoutSafe(context,api);httpStatuses[stage]=status(out.status);checkpoints[stage]=out.category==='ok';}catch{}if(!checkpoints[stage])failed();
   stage='nullsession';try{const absent=await requestSafe(context,api,{path:'/api/auth/get-session'},v=>v===null);httpStatuses[stage]=status(absent.status);checkpoints[stage]=absent.category==='ok';}catch{}if(!checkpoints[stage])failed();
   stage='protecteddenial';try{const denied=await requestSafe(context,api,{path:'/api/nodes'});httpStatuses[stage]=status(denied.status);checkpoints[stage]=[401,403].includes(denied.status);}catch{}if(!checkpoints[stage])failed();
  }
  stage='browserclosed';if(browser)try{await browser.close();checkpoints[stage]=true;}catch{}if(!checkpoints[stage])failed();
  loggedOut=checkpoints.logout&&checkpoints.nullsession&&checkpoints.protecteddenial&&checkpoints.browserclosed;
 }
 if(projection&&loggedOut){
  stage='projection';try{
   await writeFile(new URL('./instant-tools-result.json',import.meta.url),JSON.stringify(projection)+'\n',{flag:'wx',mode:0o600});
   checkpoints.projection=true;
  }catch{failed();}
 }
 // All values are constructed fixed enums/booleans/validated HTTP integers. No API
 // object, exception or string field can enter this failure sidecar, even if logout fails.
 try{
  await writeFile(new URL('./instant-tools-progress.json',import.meta.url),JSON.stringify({failedStage,checkpoints,httpStatuses})+'\n',{flag:'wx',mode:0o600});
 }catch{return safeSummary(summary('controller'));}
 if(checkpoints.projection)return safeSummary(summary('ok',200,true));
 return safeSummary(summary('controller'));
}
