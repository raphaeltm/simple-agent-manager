import {gzipSync} from 'node:zlib';
import {readFile,writeFile} from 'node:fs/promises';
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
   if(new RegExp(`^/api/projects/${project}/tasks/[0-9A-HJKMNP-TV-Z]{26}$`).test(cmd.path)&&(v?.userId!==owner||v?.agentProfileHint!==(profile?.projectId===project&&profile?.userId!==owner?profile?.id:profile?.name)||v?.projectId!==project))return false;
   return accept(v);
  }:accept;
  return deps.requestSafe(context,origin,cmd,verify);
 };
 let resumeOwn;
 if(process.env.SAM_RESUME_EXACT_VM_TASK!==undefined){
  if(process.env.SAM_RESUME_EXACT_VM_TASK!=='01M513P9XK1NB2GWQF5K36EBTV'||expected!=='01KXG9MJRZ36FFJX0RVNW67SWB')return deps.summary('configuration');
  const receipt=JSON.parse(await readFile('/tmp/reliability-vm-codex-reset/private/state/0001.json','utf8'));
  if(receipt.taskId!=='01M513P9XK1NB2GWQF5K36EBTV'||receipt.sessionId!=='b01f5478-28d0-42d6-af66-6dc57ad8223d'||receipt.branchName!=='sam/authorized-one-required-vm-36ebtv')return deps.summary('configuration');
  resumeOwn={receipt,submittedAt:Date.parse('2026-10-16T01:02:07.633Z')};
 }
 return queueRun({...deps,requestSafe,resumeOwn});
}

export function vmPrepareScript(assets){
 const hashes={'git-probe.py':'f061b7cd447cef55ceb08cb6a78fcb0b236ec3f347731e66d4b8447c224afa6c','b-probe.py':'889d7588ed44c8ab89e6ba7880ff20d81017f294bb7b31edfbc320ced064f509','terminal-observer.py':'d0970080ce89ab2810c0c9d758d1fc978efafe75fed91a4454f08639da88adff'};
 if(Object.keys(assets).sort().join()!==Object.keys(hashes).sort().join()||Object.values(assets).some(v=>typeof v!=='string'))throw new Error();
 const bundle=gzipSync(JSON.stringify(assets)).toString('base64');
 return `import pathlib,json,gzip,base64,hashlib,subprocess,sys
p=pathlib.Path('/workspaces/reliability-verification-assets');p.mkdir(parents=True,exist_ok=True)
a=json.loads(gzip.decompress(base64.b64decode('${bundle}')))
for n,b in a.items():(p/n).write_text(b)
ok=all(hashlib.sha256((p/n).read_bytes()).hexdigest()==h for n,h in json.loads('${JSON.stringify(hashes)}').items())
f=p/'asset-hashes.json';f.write_text(json.dumps({'checks':{'assetHashesMatch':ok},'statuses':{'hash':0 if ok else 1}}));f.chmod(0o600)
if ok:
 with (p/'a-prepare.json').open('w') as out:subprocess.run([sys.executable,str(p/'git-probe.py'),'prepare','--disposable-repository'],stdout=out,stderr=subprocess.DEVNULL,timeout=60)
 (p/'a-prepare.json').chmod(0o600)
`;
}
