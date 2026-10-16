/** Observe only: faithful terminal-observer check contract, standard Node runtime. */
import {readFile,writeFile,lstat,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===keys.slice().sort().join();
const sha=b=>createHash('sha256').update(b).digest('hex');
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function refs(value){
 if(typeof value!=='string'||!value.trim())throw 0;const result={};
 for(const line of value.replace(/\n$/,'').split('\n')){const m=/^([0-9a-f]{40}|[0-9a-f]{64})\t(refs\/heads\/[^\s]+)$/.exec(line);if(!m||Object.hasOwn(result,m[2]))throw 0;result[m[2]]=m[1];}
 return Object.fromEntries(Object.entries(result).sort());
}
export function inventory(v,repository,branch,limit){
 if(!Array.isArray(v)||v.length>=limit)throw 0;const seen=new Set();
 for(const p of v){if(!exact(p,['number','url','state','headRefName'])||!Number.isSafeInteger(p.number)||p.number<=0||seen.has(p.number)||p.url!==`https://github.com/${repository}/pull/${p.number}`||!['OPEN','CLOSED','MERGED'].includes(p.state)||p.headRefName!==branch)throw 0;seen.add(p.number);}
 return v.map(p=>({number:p.number,url:p.url,state:p.state,headRefName:p.headRefName})).sort((a,b)=>a.number-b.number);
}
const stamp=s=>{if(typeof s!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(s)||!Number.isFinite(Date.parse(s)))throw 0;return Date.parse(s);};
export function validateInputs(b,e,c,now=Date.now()){
 const files=['.reliability-a/tracked.txt','.reliability-a/staged-new.txt','.reliability-a/untracked.txt','.do-state.md','.workflow-state.md'];
 if(!exact(b,['head','branch','index','status','files','stagedTracked','stagedNew','remoteRefs'])||Object.entries(b).some(([k,v])=>k!=='files'&&typeof v!=='string')||![b.head,b.index].every(x=>/^[0-9a-f]{40,64}$/.test(x))||!exact(b.files,files)||Object.values(b.files).some(v=>typeof v!=='string'||!/^([0-9a-f]{64})$/.test(v))||b.branch!==c.branch)throw 0;
 const expectedRefs=refs(b.remoteRefs),repository='serverspresentation2025/crewai';
 if(!exact(e,['repository','branch','remoteRefs','prs','recordedAt','prLimit'])||e.repository!==repository||e.branch!==c.branch||e.prLimit!==100||!exact(e.remoteRefs,Object.keys(expectedRefs))||Object.keys(expectedRefs).some(k=>e.remoteRefs[k]!==expectedRefs[k]))throw 0;
 const prs=inventory(e.prs,repository,c.branch,100);if(!(stamp(e.recordedAt)<stamp(c.completedAt)&&stamp(c.completedAt)<=now))throw 0;
 return {expectedRefs,prs};
}
/** Detached child session, bounded pipes, one global deadline, kill entire group on every exit. */
export function run(argv,deadline){return new Promise((accept,reject)=>{
 let child,done=false,bytes=0,out=[];const remaining=deadline-Date.now();if(remaining<=0)return reject(0);
 const finish=(err,value)=>{if(done)return;done=true;clearTimeout(timer);if(child?.pid)try{process.kill(-child.pid,'SIGKILL');}catch{}child?.stdout?.destroy();child?.stderr?.destroy();err?reject(0):accept(value);};
 const timer=setTimeout(()=>finish(true),Math.min(5000,remaining));
 try{child=spawn(argv[0],argv.slice(1),{detached:true,stdio:['ignore','pipe','pipe']});child.on('error',()=>finish(true));child.stdout.on('data',b=>{bytes+=b.length;if(bytes>131072)finish(true);else out.push(b);});child.stderr.on('data',b=>{bytes+=b.length;if(bytes>262144)finish(true);});child.on('exit',code=>{if(code!==0)finish(true);});child.on('close',code=>finish(code!==0,Buffer.concat(out)));}catch{finish(true);}
 });}
async function checked(path,limit=131072){const st=await lstat(path);if(!st.isFile()||st.isSymbolicLink()||st.size>limit)throw 0;const b=await readFile(path);if(b.length>limit)throw 0;return b;}
const save=(p,b)=>writeFile(p,b,{flag:'wx',mode:0o600});
export async function main(directory){
 let c,status=1,files=[];const deadline=Date.now()+15000;
 try{c=JSON.parse(await checked(directory+'/config.json',400000));
 if(!exact(c,['taskId','sessionId','branch','runId','operation','assets','baseline','expectations','completedAt'])||c.operation!=='observe'||!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(c.taskId)||!/^[0-9a-f-]{36}$/.test(c.sessionId)||!/^[0-9a-f-]{36}$/.test(c.runId)||!/^sam\/[a-z0-9][a-z0-9/-]{0,150}$/.test(c.branch))throw 0;
 const root=await realpath(process.cwd());if((await run(['git','rev-parse','--show-toplevel'],deadline)).toString().trim()!==root)throw 0;
 // These are the existing reviewed observer source assets, retained and hash checked for provenance.
 const hashes={'git-probe.py':'f061b7cd447cef55ceb08cb6a78fcb0b236ec3f347731e66d4b8447c224afa6c','b-probe.py':'889d7588ed44c8ab89e6ba7880ff20d81017f294bb7b31edfbc320ced064f509','terminal-observer.py':'d0970080ce89ab2810c0c9d758d1fc978efafe75fed91a4454f08639da88adff'};
 if(!exact(c.assets,Object.keys(hashes)))throw 0;
 for(const [n,h]of Object.entries(hashes)){if(typeof c.assets[n]!=='string'||sha(Buffer.from(c.assets[n],'base64'))!==h)throw 0;}
 const baseline=Buffer.from(c.baseline,'base64'),expectations=Buffer.from(c.expectations,'base64');
 const {expectedRefs,prs}=validateInputs(JSON.parse(baseline),JSON.parse(expectations),c);
 await save(directory+'/baseline.json',baseline);await save(directory+'/expectations.json',expectations);
 await save(directory+'/asset-hashes.json',JSON.stringify({checks:{assetHashesMatch:true},statuses:{hash:0}}));
 const observedRefs=refs((await run(['git','ls-remote','--heads','https://github.com/serverspresentation2025/crewai.git'],deadline)).toString());
 const observedPrs=inventory(JSON.parse(await run(['gh','pr','list','--repo','serverspresentation2025/crewai','--head',c.branch,'--state','all','--limit','100','--json','number,url,state,headRefName'],deadline)),'serverspresentation2025/crewai',c.branch,100);
 const checks={remoteRefsUnchanged:equal(observedRefs,expectedRefs),taskBranchPrInventoryUnchanged:equal(observedPrs,prs),observedAfterTerminal:true};
 await save(directory+'/observer.json',JSON.stringify({checks,statuses:{remoteRefs:0,prInventory:0}}));if(!Object.values(checks).every(v=>v===true))throw 0;
 status=0;files=['asset-hashes.json','observer.json'];
 }catch{}
 if(c&&typeof c.taskId==='string'&&typeof c.sessionId==='string'&&typeof c.runId==='string'){
 const digests={};for(const n of files)digests[n]=sha(await checked(directory+'/'+n));
 await save(directory+'/done.json',JSON.stringify({taskId:c.taskId,sessionId:c.sessionId,runId:c.runId,operation:'observe',status,files:digests}));}
 return status;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)process.exitCode=await main(process.argv[2]);
