import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
const supervisor=fileURLToPath(new URL('./safe-controller.mjs',import.meta.url));
const canary='ghs_'+'PrivateCanary'.repeat(4);
test('actual supervised fixed-session metadata reads bind twice and drop raw content',async()=>{
 const source=await readFile(new URL('./diagnose-instant-tools.mjs',import.meta.url),'utf8');
 for(const mode of ['ok','incomplete','unknown','missing-name','foreign-message','foreign-binding','changed-binding','denied','logout-failed','future-time']){
  const dir=await mkdtemp(join(tmpdir(),'sam-instant-tools-'));
  try{
   const fixture={task:'01M50WGVQRS08BCA1SEDEZNG0V',session:'8898726c-23b7-4546-b6d8-ae4c7f707e6d',workspace:'01M50WGXPZESSX4D37TQ5DDJCW',branch:'sam/authorized-minimal-instant-claude-ezng0v',project:'01KJNR9R3TEN3KX1ETE33852R8'};
   const mock=join(dir,'mock.mjs');
   await writeFile(mock,`const canary=${JSON.stringify(canary)},mode=${JSON.stringify(mode)},f=${JSON.stringify(fixture)};
    let binds=0,closed=false,signedOut=false,sequence=[];
    export const chromium={launch:async()=>({newContext:async()=>({request:{fetch:async(url,o)=>{
     console.log(canary);console.error(canary);
     if(o.headers.Origin!=='https://api.sammy.party'||o.maxRedirects!==0||closed)throw new Error(canary);
     const u=new URL(url),p=u.pathname;
     sequence.push(p);
     if(!['/api/auth/token-login','/api/auth/sign-out','/api/auth/get-session','/api/nodes'].includes(p)&&o.method!=='GET')throw new Error(canary);
     let data={},status=200;
     if(p==='/api/auth/sign-out'){signedOut=true;if(mode==='logout-failed')status=500;}
     else if(p==='/api/auth/get-session')data=signedOut?null:{cookie:canary};
     else if(p==='/api/nodes')status=signedOut?403:200;
     else if(p.endsWith('/tasks/'+f.task))data={id:f.task,projectId:f.project,workspaceId:f.workspace,outputBranch:f.branch,taskMode:'task',agentProfileHint:'01KYQ60N603GE9G3Y767K9NSW4',status:'in_progress',outputSummary:canary};
     else if(p.endsWith('/sessions/'+f.session)){
      if(u.search!=='?limit=1')throw new Error(canary);binds++;
      data={session:{id:f.session,taskId:(mode==='foreign-binding'||mode==='changed-binding'&&binds===2)?canary:f.task,workspaceId:f.workspace,task:{id:f.task,outputBranch:f.branch},title:canary},messages:[{content:canary}]};
     }else if(p.endsWith('/messages')){
      if(binds!==1||u.search!=='?limit=100&order=desc&compact=true')throw new Error(canary);
      if(mode==='denied')status=403;
      const meta={toolName:mode==='unknown'?canary:'mcp__sam-mcp__upload_to_library',status:mode==='unknown'?canary:'completed',rawInput:{secret:canary},rawOutput:canary,title:canary,locations:[canary]};
      if(mode==='missing-name')delete meta.toolName;
      data={messages:[{sessionId:mode==='foreign-message'?canary:f.session,role:'tool',createdAt:mode==='future-time'?Date.now()+60000:1792105400000,content:canary,toolMetadata:meta},{sessionId:f.session,role:'assistant',createdAt:1792105400001,content:canary}],hasMore:mode==='incomplete',...(mode==='incomplete'?{skippedMessages:2}:{}),cursor:canary};
     }else if(p.endsWith('/interactions'))data={pending:[{kind:'permission',state:'pending',createdAt:1792105400000,deadlineAt:1792115400000,updatedAt:1792105400001,payload:canary,options:[canary],url:canary,title:canary,toolCallId:canary}],settled:[],cursor:mode==='incomplete'?canary:null};
     else if(p!=='/api/auth/token-login')throw new Error(canary);
     return {status:()=>status,json:async()=>data,dispose:async()=>{}};
    }}}),close:async()=>{closed=true;if(!signedOut)throw new Error(canary);}})};`);
   const entry=join(dir,'entry.mjs');
   await writeFile(entry,source.replace("'/tmp/reliability-browser-deps/node_modules/playwright/index.mjs'",JSON.stringify(pathToFileURL(mock).href)));
   const child=spawnSync(process.execPath,[supervisor,entry,'3000'],{encoding:'utf8',timeout:5000,env:{...process.env,SAM_PLAYWRIGHT_PRIMARY_USER:canary}});
   assert.equal(child.error,undefined,mode);assert.equal(child.status,0,mode);assert.equal(child.stderr,'');assert.ok(!child.stdout.includes(canary));
   const success=['ok','incomplete','unknown','missing-name'].includes(mode);
   assert.equal(JSON.parse(child.stdout).category,success?'ok':'controller',mode);
   const output=join(dir,'instant-tools-result.json');
   if(success){
    const raw=await readFile(output,'utf8');assert.ok(!raw.includes(canary));const safe=JSON.parse(raw);
    assert.equal((await stat(output)).mode&0o777,0o600);assert.equal(safe.underlyingCause,'unknown');assert.equal(safe.retentionVerified,false);assert.equal(safe.noExecutionProven,false);
    assert.equal(safe.messages.complete,mode!=='incomplete');assert.equal(safe.interactions.complete,mode!=='incomplete');
    assert.equal(safe.messages.roles.assistant,1);assert.equal(safe.interactions.pending.kinds.permission,1);
    assert.equal(safe.messages.tools[0].tool,['unknown','missing-name'].includes(mode)?'unknown':'mcp__sam-mcp__upload_to_library');
    assert.equal(safe.messages.missingToolName,mode==='missing-name'?1:0);
   }else await assert.rejects(readFile(output));
  }finally{await rm(dir,{recursive:true,force:true});}
 }
});
