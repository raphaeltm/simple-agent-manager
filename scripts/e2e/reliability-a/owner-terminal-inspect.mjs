/** Verification only. No CLI, login, wake, adoption, reset, prepare or generic command interface.
 * Caller owns the existing approved browser, supervised deadline and logout/browser closure.
 * Initial scope is ONLY inspecting the exact preserved Claude fixture after separately reviewed GO.
 */
import {randomUUID,createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
const api='https://api.sammy.party',app='https://app.sammy.party';
const project='01KJNR9R3TEN3KX1ETE33852R8',task='01M51CCMB1S684RXVNBNDQRDAS';
const session='1135ad88-96dd-4ec2-a1d1-5813d295d2a5',branch='sam/authorized-one-required-reliability-dqrdas';
const profile='01KRS7Z2R88JFC73ARA7DV9WTK';
const hashes={'git-probe.py':'f061b7cd447cef55ceb08cb6a78fcb0b236ec3f347731e66d4b8447c224afa6c','b-probe.py':'889d7588ed44c8ab89e6ba7880ff20d81017f294bb7b31edfbc320ced064f509','terminal-observer.py':'d0970080ce89ab2810c0c9d758d1fc978efafe75fed91a4454f08639da88adff'};
const exact=(v,k)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===k.slice().sort().join();
const ulid=v=>typeof v==='string'&&/^[0-9A-HJKMNP-TV-Z]{26}$/.test(v);
const sha=v=>createHash('sha256').update(v).digest('hex');
const checkKeys=['repositoryRoot','branchMatches','fixtureDirectory','baselineFile','expectationsFile','gitProbeHash','bProbeHash','observerHash'];

// Fixed read operations only; no Git writes or original-artifact modification.
export function inspectionCommand(runId){
 if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(runId))throw new Error('configuration');
 const directory=`/workspaces/reliability-owner-inspect/${task}/${runId}`;
 const code=`import pathlib,subprocess,json,hashlib,os,signal
signal.alarm(25)
p=pathlib.Path(${JSON.stringify(directory)});p.mkdir(parents=True,exist_ok=False,mode=0o700)
def git(*args):
 child=None
 try:
  child=subprocess.Popen(['git',*args],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,start_new_session=True)
  data,_=child.communicate(timeout=5)
  return child.returncode,data[:4096].decode('utf-8','replace').strip()
 except Exception:
  if child is not None:
   try:os.killpg(child.pid,signal.SIGKILL)
   except ProcessLookupError:pass
   child.communicate(timeout=2)
  return 255,''
rs,root=git('rev-parse','--show-toplevel');bs,b=git('branch','--show-current')
r=pathlib.Path(root) if rs==0 and root else pathlib.Path.cwd()
a=pathlib.Path('/workspaces/reliability-verification-assets')
c={'repositoryRoot':rs==0 and pathlib.Path.cwd().resolve()==r.resolve(),'branchMatches':bs==0 and b==${JSON.stringify(branch)},'fixtureDirectory':(r/'.reliability-a').is_dir(),'baselineFile':(r/'.reliability-a/baseline.json').is_file(),'expectationsFile':(a/'expectations.json').is_file()}
for key,name,digest in ${JSON.stringify([['gitProbeHash','git-probe.py',hashes['git-probe.py']],['bProbeHash','b-probe.py',hashes['b-probe.py']],['observerHash','terminal-observer.py',hashes['terminal-observer.py']]])}:
 try:
  with (a/name).open('rb') as f:data=f.read(100001)
  c[key]=len(data)<=100000 and hashlib.sha256(data).hexdigest()==digest
 except Exception:c[key]=False
v={'checks':c,'statuses':{'gitRoot':rs,'gitBranch':bs}}
def save(name,value):
 q=p/(name+'.tmp');q.write_text(json.dumps(value,separators=(',',':')));q.chmod(0o600);os.replace(q,p/name)
save('state.json',v)
save('done.json',{'taskId':${JSON.stringify(task)},'sessionId':${JSON.stringify(session)},'runId':${JSON.stringify(runId)},'operation':'read-state','status':0,'stateSha256':hashlib.sha256((p/'state.json').read_bytes()).hexdigest()})
`;
 const payload=gzipSync(code).toString('base64');
 // One small shell line, below the Linux canonical PTY input limit. No bare Python/shebang.
 const command=`{ for p in /opt/uv-python/*/bin/python3 /usr/bin/python3 /usr/local/bin/python3; do if [ -x "$p" ] && "$p" -c 'import sys;assert sys.executable.startswith("/")' >/dev/null 2>&1; then "$p" -c 'import gzip,base64;exec(gzip.decompress(base64.b64decode("${payload}")))'; break; fi; done; } >/dev/null 2>&1\n`;
 if(Buffer.byteLength(command)>3800)throw new Error('configuration');
 return {command,directory};
}

/** Browser-native WebSocket: configured app Origin, no Node headers/auth bypass.
 * All terminal output/scrollback/error contents are discarded in page RAM.
 */
export async function browserTerminal(page,url,id){
 if(new URL(page.url()).origin!==app)throw new Error('origin');
 await page.evaluate(({url,id})=>new Promise((resolve,reject)=>{
  if(globalThis.__reliabilityOwnedTerminal) return reject();
  const socket=new WebSocket(url),state={socket,created:false,closed:false,failed:false};
  const timer=setTimeout(()=>{socket.close();delete globalThis.__reliabilityOwnedTerminal;reject();},5000);
  globalThis.__reliabilityOwnedTerminal=state;
  socket.onmessage=e=>{try{const v=JSON.parse(e.data);if(v.type==='session_created'&&v.sessionId===id&&v.data?.sessionId===id)state.created=true;
   else if(v.type==='session_closed'&&v.sessionId===id&&v.data?.sessionId===id&&v.data?.reason==='user_requested')state.closed=true;
   else if(v.type==='error')state.failed=true;}catch{state.failed=true;}};
  socket.onerror=()=>{clearTimeout(timer);state.failed=true;socket.close();delete globalThis.__reliabilityOwnedTerminal;reject();};
  socket.onopen=()=>{clearTimeout(timer);resolve();};
 }),{url,id});
 return {
  send:frame=>page.evaluate(frame=>{globalThis.__reliabilityOwnedTerminal.socket.send(JSON.stringify(frame));},frame),
  state:()=>page.evaluate(()=>{const s=globalThis.__reliabilityOwnedTerminal;return {created:s.created,closed:s.closed,failed:s.failed};}),
  dispose:()=>page.evaluate(()=>{const s=globalThis.__reliabilityOwnedTerminal;if(s){s.socket.onmessage=null;s.socket.onerror=null;s.socket.close();delete globalThis.__reliabilityOwnedTerminal;}}),
 };
}

/** grant is a run-specific, independently reviewed fresh host binding, NEVER API-derived adoption.
 * It includes separately verified stored profile ID and fresh expected profile owner.
 * Project capability permits a project profile owned by another user; global profiles remain own-only.
 * Display-name matching alone is insufficient.
 * Supervisor must bound this call to 90s; no automatic retry on incomplete command/PTY closure.
 */
export async function inspectOwnedFixture({context,page,grant,open=browserTerminal,now=Date.now,pause=ms=>new Promise(r=>setTimeout(r,ms))}){
 const result={ok:false,stage:'binding',before:false,after:false,manifest:false,terminalClosed:false,socketClosed:false,quiescence:false};
 let terminal,created=false,token;
 const runId=randomUUID(),started=now(),deadline=started+60000;
 const live=()=>{if(now()>=deadline)throw new Error('deadline');};
 const json=async(path,method='GET',data)=>{
  live();const r=await context.request.fetch(api+path,{method,data,headers:{Origin:app},timeout:5000,maxRedirects:0,failOnStatusCode:false});
  try{if(r.status()!==200)throw 0;const b=await r.body();if(b.length>200000)throw 0;return JSON.parse(b.toString('utf8'));}finally{await r.dispose();}
 };
 const bind=async()=>{
  if(!exact(grant,['workspaceId','nodeId','ownerId','expectedProfileOwnerId','agentSessionId','runtime','agentVersion','expiresAt','storedProfileId','storedProfileObservedAt','receipt'])||!ulid(grant.workspaceId)||!ulid(grant.nodeId)||!ulid(grant.agentSessionId)||grant.runtime!=='vm'||grant.agentVersion!=='b467f389811eadeaf973960bb30f9fa7b9cb4678'
   ||typeof grant.expectedProfileOwnerId!=='string'||!grant.expectedProfileOwnerId||grant.expectedProfileOwnerId.length>128
   ||typeof grant.ownerId!=='string'||!grant.ownerId||grant.storedProfileId!==profile||!Number.isSafeInteger(grant.expiresAt)||grant.expiresAt<=now()||grant.expiresAt>started+300000
   ||!Number.isSafeInteger(grant.storedProfileObservedAt)||grant.storedProfileObservedAt>now()||now()-grant.storedProfileObservedAt>300000
   ||!exact(grant.receipt,['taskId','sessionId','branchName','status'])||grant.receipt.taskId!==task||grant.receipt.sessionId!==session||grant.receipt.branchName!==branch||grant.receipt.status!=='queued')throw 0;
  const owner=await json('/api/auth/get-session');if(owner?.user?.id!==grant.ownerId)throw 0;
  const p=await json(`/api/projects/${project}/agent-profiles/${profile}`);
  if(p?.id!==profile||p.userId!==grant.expectedProfileOwnerId||p.agentType!=='claude-code'||!(p.runtime===null||p.runtime==='vm')||p.vmSizeOverride!=null||typeof p.name!=='string'||!p.name
   ||!(p.projectId===project||(p.projectId===null&&p.userId===grant.ownerId)))throw 0;
  const profiles=await json(`/api/projects/${project}/agent-profiles`);
  if(!Array.isArray(profiles?.items)||profiles.items.filter(x=>x?.name===p.name).length!==1||!profiles.items.some(x=>x?.id===profile&&x.name===p.name))throw 0;
  const t=await json(`/api/projects/${project}/tasks/${task}`),s=await json(`/api/projects/${project}/sessions/${session}?limit=1`),w=await json(`/api/workspaces/${grant.workspaceId}`);
  const runtime=await json(`/api/projects/${project}/sessions/${session}/state`);
  // Display lookup is caller-owned only: shared foreign-owned project IDs remain IDs.
  const publicHint=p.userId===grant.ownerId?p.name:profile;
  // Public Task DTO has no chatSessionId; session.taskId + workspace.chatSessionId
  // and the independent stored task/session grant provide that association.
  if(t?.id!==task||t.projectId!==project||t.userId!==grant.ownerId||t.outputBranch!==branch||t.workspaceId!==grant.workspaceId||t.agentProfileHint!==publicHint
   ||!['in_progress','completed'].includes(t.status)||s?.session?.id!==session||s.session.taskId!==task||s.session.workspaceId!==grant.workspaceId||s.session.agentType!=='claude-code'
   ||s.session.agentSessionId!==grant.agentSessionId||runtime?.agentSessionId!==grant.agentSessionId||runtime.agentType!=='claude-code'
   ||w?.id!==grant.workspaceId||w.nodeId!==grant.nodeId||w.projectId!==project||w.chatSessionId!==session||w.branch!==branch||w.repository!=='serverspresentation2025/crewai'||w.status!=='running'||w.hardware?.cloudProvider!=='hetzner')throw 0;
  return `https://ws-${grant.workspaceId}.sammy.party`;
 };
 const wait=async(key,until=deadline)=>{for(let i=0;i<50;i++){if(now()>=until)throw 0;const s=await terminal.state();if(s.failed)throw 0;if(s[key])return;await pause(100);}throw 0;};
 try{
  const workspaceUrl=await bind();result.before=true;result.stage='terminal-token';
  const access=await json('/api/terminal/token','POST',{workspaceId:grant.workspaceId});
  if(access?.workspaceUrl!==workspaceUrl||typeof access.token!=='string'||access.token.length<32||access.token.length>16000||!Number.isFinite(Date.parse(access.expiresAt))||Date.parse(access.expiresAt)<=now())throw 0;
  token=access.token;result.stage='terminal-create';
  terminal=await open(page,workspaceUrl.replace('https:','wss:')+'/terminal/ws/multi?token='+encodeURIComponent(token),runId);
  await terminal.send({type:'create_session',data:{sessionId:runId,rows:24,cols:80,name:'fixed verification'}});created=true;await wait('created');
  const {command,directory}=inspectionCommand(runId);result.stage='read-state';
  await terminal.send({type:'input',sessionId:runId,data:{data:command}});
  const download=async name=>{live();const r=await context.request.fetch(workspaceUrl+`/workspaces/${grant.workspaceId}/files/download?path=`+encodeURIComponent(directory+'/'+name)+'&token='+encodeURIComponent(token),{headers:{Origin:app},timeout:5000,maxRedirects:0,failOnStatusCode:false});
   try{if(r.status()===404)return null;if(r.status()!==200)throw 0;const length=(await r.headers())['content-length'];if(length!==undefined&&(!/^\d{1,5}$/.test(length)||Number(length)>16000))throw 0;const b=await r.body();if(b.length>16000||(length!==undefined&&b.length!==Number(length)))throw 0;return b;}finally{await r.dispose();}};
  let done;
  for(let i=0;i<20;i++){const b=await download('done.json');if(b){done=JSON.parse(b.toString('utf8'));break;}await pause(1000);}
  if(!exact(done,['taskId','sessionId','runId','operation','status','stateSha256'])||done.taskId!==task||done.sessionId!==session||done.runId!==runId||done.operation!=='read-state'||done.status!==0||!/^[a-f0-9]{64}$/.test(done.stateSha256))throw 0;
  const bytes=await download('state.json');if(!bytes||sha(bytes)!==done.stateSha256)throw 0;const state=JSON.parse(bytes.toString('utf8'));
  if(!exact(state,['checks','statuses'])||!exact(state.checks,checkKeys)||Object.values(state.checks).some(v=>typeof v!=='boolean')||!exact(state.statuses,['gitRoot','gitBranch'])||Object.values(state.statuses).some(v=>!Number.isInteger(v)||v<0||v>255))throw 0;
  result.manifest=true;result.state=state;result.stage='canonical-after';await bind();result.after=true;
 }catch{}finally{
  result.stage=result.after?'terminal-close':result.stage;
  // Reserve a separate 5s cleanup window after the action deadline, within caller's 90s ceiling.
  if(terminal)try{if(created){const cleanupDeadline=Math.min(now()+5000,started+80000);await terminal.send({type:'close_session',data:{sessionId:runId}});await wait('closed',cleanupDeadline);result.terminalClosed=true;}}catch{}
  if(terminal)try{await terminal.dispose();result.socketClosed=true;}catch{}
  token=undefined;
 }
 result.quiescence=result.before&&result.after&&result.manifest&&result.terminalClosed&&result.socketClosed;
 result.ok=result.quiescence;
 if(result.ok)result.stage='done';
 // Fixed projection only; never forward exceptions, API bodies, names, JWTs, URLs or PTY output.
 return result;
}
