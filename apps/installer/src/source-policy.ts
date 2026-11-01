// Serialized into both independently runnable owner-account modules. No browser
// supplied origins, executable paths or credentials enter these public-source reads.
export const sourcePolicyFactory = String.raw`(()=>{
 const repository='https://api.github.com/repos/raphaeltm/simple-agent-manager';
 const raw='https://raw.githubusercontent.com/raphaeltm/simple-agent-manager/';
 const headers={'User-Agent':'SAM-owner-maintenance','Accept':'application/vnd.github+json'};
 const paths={bootstrap:'scripts/deploy/installer-builder-bootstrap.sh',engine:'scripts/deploy/installer-engine-cli.ts',sourceBuild:'scripts/deploy/installer-builder-bootstrap-source-build.sh'};
 const capabilities=['source-build','durable-maintenance','owner-binding','resumable-deploy'];
 async function json(url,limit=65536){
  const response=await fetch(url,{headers,signal:AbortSignal.timeout(10000)});
  if(response.status===404)throw new Error('Source missing');if(!response.ok)throw new Error('Source unavailable');
  if(Number(response.headers.get('Content-Length')||0)>limit)throw new Error('Invalid source metadata');
  const reader=response.body?.getReader();if(!reader)throw new Error('Invalid source metadata');
  const decoder=new TextDecoder();let text='',size=0;
  while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>limit){await reader.cancel();throw new Error('Invalid source metadata');}text+=decoder.decode(part.value,{stream:true});}
  text+=decoder.decode();return JSON.parse(text);
 }
 async function verify(sourceCommit,previousSourceCommit){
  if(!/^[a-f0-9]{40}$/.test(sourceCommit)||previousSourceCommit!==undefined&&!/^[a-f0-9]{40}$/.test(previousSourceCommit))return {ok:false,reason:'unsupported-source'};
  try{
   if(previousSourceCommit!==undefined){
    const compared=await json(repository+'/compare/'+previousSourceCommit+'...'+sourceCommit+'?per_page=1&page=2');
    if(compared.status!=='ahead'||!Number.isSafeInteger(compared.ahead_by)||compared.ahead_by<1||compared.behind_by!==0)return {ok:false,reason:'not-forward'};
   }
   const protocol=await json(raw+sourceCommit+'/scripts/deploy/installer-protocol.json');
   if(protocol.schemaVersion!==1||protocol.protocolVersion!==1||!Array.isArray(protocol.capabilities)||capabilities.some(value=>!protocol.capabilities.includes(value))||!protocol.entrypoints||Object.entries(paths).some(([key,value])=>protocol.entrypoints[key]!==value))return {ok:false,reason:'unsupported-source'};
   for(const path of Object.values(paths)){
    const response=await fetch(raw+sourceCommit+'/'+path,{method:'HEAD',headers,signal:AbortSignal.timeout(10000)});
    if(!response.ok)return {ok:false,reason:'unsupported-source'};
   }
   return {ok:true,proof:{protocolVersion:1,sourceCommit,...(previousSourceCommit?{previousSourceCommit}:{})}};
  }catch(error){return {ok:false,reason:error?.message==='Source missing'?'unsupported-source':'source-unavailable'};}
 }
 function matches(proof,config){return proof?.protocolVersion===1&&proof.sourceCommit===config.sourceCommit&&proof.previousSourceCommit===config.previousSourceCommit;}
 return {verify,matches};
})()`;
