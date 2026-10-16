import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {run as queueRun} from './queue-controller.mjs';
const project='01KJNR9R3TEN3KX1ETE33852R8';
const safeInteger=v=>typeof v==='string'&&/^\d{1,15}$/.test(v)&&Number.isSafeInteger(Number(v))?Number(v):null;
export async function run(deps){
 let owner=null,profile=null;
 const root=process.env.SAM_VERIFICATION_ROOT,expected=process.env.SAM_EXPECTED_VM_PROFILE,agent=process.env.SAM_EXPECTED_VM_AGENT;
 if(!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(expected??'')||!['openai-codex','claude-code'].includes(agent))return deps.summary('configuration');
 const requestSafe=async(context,origin,cmd,accept)=>{
  if(cmd.path==='/api/auth/token-login'){
   const fetch=context.request.fetch.bind(context.request);
   context.request.fetch=async(...args)=>{
    const response=await fetch(...args);
    try{if(response.status()===429){const h=await response.headers();await writeFile(join(root,'login-rate-metadata.json'),JSON.stringify({status:429,retryAfterSeconds:safeInteger(h['retry-after']),resetAtSeconds:safeInteger(h['x-ratelimit-reset'])})+'\n',{mode:0o600,flag:'wx'});}}catch{}
    return response;
   };
   let result;try{result=await deps.requestSafe(context,origin,cmd,accept);}finally{context.request.fetch=fetch;}
   if(result.category!=='ok')return result;
   const session=await deps.requestSafe(context,origin,{path:'/api/auth/get-session'},v=>{owner=v?.user?.id;return typeof owner==='string'&&owner.length>0&&owner.length<=128;});
   if(session.category!=='ok')return session;
   const visible=await deps.requestSafe(context,origin,{path:`/api/projects/${project}/agent-profiles/${expected}`},v=>{
    profile=v;return v?.id===expected&&v.agentType===agent&&(v.runtime===null||v.runtime==='vm')&&((v.projectId===project)||(v.projectId===null&&v.userId===owner))&&typeof v.name==='string'&&v.name.length>0&&v.name.length<=256&&v.vmSizeOverride==null;
   });
   await writeFile(join(root,'profile-preflight.json'),JSON.stringify({authenticatedOwnerPresent:!!owner,exactProfileVisible:visible.category==='ok',sharedProjectProfile:profile?.projectId===project,agentMatches:profile?.agentType===agent,normalVmRuntime:profile?.runtime===null||profile?.runtime==='vm',noSizingOverride:profile?.vmSizeOverride==null})+'\n',{mode:0o600,flag:'wx'});
   return visible.category==='ok'?result:visible;
  }
  if(cmd.path===`/api/projects/${project}/tasks/submit`&&(!profile||cmd.data?.agentProfileId!==profile.id))return deps.summary('configuration');
  const verify=typeof accept==='function'?async v=>{
   if(new RegExp(`^/api/projects/${project}/tasks/[0-9A-HJKMNP-TV-Z]{26}$`).test(cmd.path)&&(v?.userId!==owner||v?.agentProfileHint!==profile?.name||v?.projectId!==project))return false;
   return accept(v);
  }:accept;
  return deps.requestSafe(context,origin,cmd,verify);
 };
 return queueRun({...deps,requestSafe});
}
