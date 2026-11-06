/** One explicitly invoked paid cold-build proof. Deployment credentials stay in
 * this launcher; the managed container receives no cloud credential whatsoever.
 * No app/DNS/D1/Pulumi mutation is performed. Delete only this unique proof's
 * Container application and Worker. GitHub staging environment supplies CF_*.
 */
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const PROOF_SECONDS = 3600;
export const PROOF_INSTANCE = 'standard-3';
export const PROOF_COMPUTE_UPPER_USD =
  PROOF_SECONDS * (2 * 0.00002 + 8 * 0.0000025 + 16 * 0.00000007);

const supervisor = String.raw`
const http=require('node:http'),fs=require('node:fs'),{spawn}=require('node:child_process');
fs.mkdirSync('/sam/job',{recursive:true,mode:448});let state='running',errorTail='',peakDiskUsedBytes=0,peakMemoryBytes;
function sample(){try{const s=fs.statfsSync('/');peakDiskUsedBytes=Math.max(peakDiskUsedBytes,(s.blocks-s.bfree)*s.bsize);}catch{}for(const file of ['/sys/fs/cgroup/memory.peak','/sys/fs/cgroup/memory.current']){try{const n=Number(fs.readFileSync(file,'utf8'));if(Number.isFinite(n))peakMemoryBytes=Math.max(peakMemoryBytes||0,n);}catch{}}}sample();setInterval(sample,5000);
const command='set -eu; umask 077; export DEBIAN_FRONTEND=noninteractive; apt-get update -qq; apt-get install -y -qq --no-install-recommends git ca-certificates; git clone https://github.com/raphaeltm/simple-agent-manager.git /sam/source; git -C /sam/source checkout --detach "$SAM_SOURCE_COMMIT"; test "$(git -C /sam/source rev-parse HEAD)" = "$SAM_SOURCE_COMMIT"; exec bash /sam/source/scripts/deploy/installer-builder-bootstrap.sh';
const child=spawn('sh',['-c',command],{stdio:['ignore','ignore','pipe'],env:process.env});child.stderr.on('data',chunk=>{errorTail=(errorTail+chunk.toString()).slice(-4096);});
child.once('error',()=>{state='failed';});child.once('close',code=>{state=code===0?'completed':'failed';});
http.createServer((req,res)=>{if(req.url!=='/status'||req.headers.authorization!=='Bearer '+process.env.SAM_PROOF_KEY){res.writeHead(403);res.end();return;}let fit;try{if(fs.statSync('/sam/job/fit.json').size<4096)fit=JSON.parse(fs.readFileSync('/sam/job/fit.json','utf8'));}catch{}sample();fit={...(fit||{phase:'bootstrap'}),peakDiskUsedBytes,...(peakMemoryBytes!==undefined?{peakMemoryBytes}:{})};res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({state,fit,...(state==='failed'?{errorTail:errorTail.split(process.env.SAM_PROOF_KEY).join('[redacted]')}:{})}));}).listen(8080,'0.0.0.0');
`;

export function proofWorkerSource(): string {
  return String.raw`
const SUPERVISOR=${JSON.stringify(supervisor)};
export class BuildProof{
 constructor(ctx,env){this.ctx=ctx;this.env=env;this.queue=Promise.resolve();}
 fetch(request){const run=this.queue.then(()=>this.handle(request));this.queue=run.catch(()=>{});return run;}
 async handle(request){
  if(request.headers.get('Authorization')!=='Bearer '+this.env.PROOF_KEY)return new Response('',{status:403});
  const path=new URL(request.url).pathname;
  if(path==='/start'&&request.method==='POST'){
   if(await this.ctx.storage.get('job'))return new Response('',{status:409});
   const job={status:'running',deadline:Date.now()+3600000};await this.ctx.storage.put('job',job);await this.ctx.storage.setAlarm(Date.now()+5000);
   this.ctx.container.start({image:'cloudflare/debian-trixie',instance:'standard-3',enableInternet:true,entrypoint:['node','-e',SUPERVISOR],env:{SAM_SOURCE_COMMIT:this.env.SOURCE_COMMIT,SAM_PROOF_KEY:this.env.PROOF_KEY,SAM_JOB_DIRECTORY:'/sam/job',SAM_BUILD_FIT_ONLY:'1'},labels:{proof:'cold-build'}});
   return Response.json(job,{status:202});
  }
  if(path==='/cancel'&&request.method==='POST'){await this.stop('cancelled');return Response.json(await this.ctx.storage.get('job'));}
  if(path==='/status'&&request.method==='GET'){await this.poll();return Response.json(await this.ctx.storage.get('job')||{status:'idle'});}
  return new Response('',{status:404});
 }
 async stop(status){const job=await this.ctx.storage.get('job')||{};job.status=status;job.stopping=true;await this.ctx.storage.put('job',job);await this.ctx.container.destroy('SAM proof '+status);delete job.stopping;await this.ctx.storage.put('job',job);await this.ctx.storage.deleteAlarm();}
 async poll(){
  const job=await this.ctx.storage.get('job');if(!job)return;if(job.stopping){await this.stop(job.status);return;}if(job.status!=='running')return;
  if(Date.now()>=job.deadline){await this.stop('timed_out');return;}await this.ctx.storage.setAlarm(Math.min(job.deadline,Date.now()+5000));
  if(!await this.ctx.container.inspect()){await this.stop('interrupted');return;}
  try{const response=await this.ctx.container.getTcpPort(8080).fetch('http://proof/status',{headers:{Authorization:'Bearer '+this.env.PROOF_KEY},signal:AbortSignal.timeout(4000)});if(!response.ok)return;const raw=await response.text();if(raw.length>8192){await this.stop('failed');return;}const status=JSON.parse(raw);if(status.state==='failed'&&typeof status.errorTail==='string')job.errorTail=status.errorTail.slice(-4096).split(this.env.PROOF_KEY).join('[redacted]');if(status.fit&&typeof status.fit.phase==='string'&&/^[a-z-]{1,64}$/.test(status.fit.phase)){job.fit={phase:status.fit.phase};for(const key of ['at','diskUsedBytes','diskAvailableBytes','peakMemoryBytes','peakDiskUsedBytes'])if(Number.isFinite(status.fit[key])&&status.fit[key]>=0)job.fit[key]=status.fit[key];}await this.ctx.storage.put('job',job);if(status.state==='completed'||status.state==='failed')await this.stop(status.state);}catch{}
 }
 alarm(){const run=this.queue.then(()=>this.poll());this.queue=run.catch(()=>{});return run;}
}
export default{fetch(request,env){return env.PROOF.get(env.PROOF.idFromName('one-cold-build')).fetch(request);}};
`;
}

export function ownsProofWorker(settings: unknown, ownership: string, commit: string): boolean {
  if (!settings || typeof settings !== 'object') return false;
  const bindings = (settings as { bindings?: { name: string; text?: string }[] }).bindings;
  return (
    Array.isArray(bindings) &&
    bindings.some((binding) => binding.name === 'PROOF_OWNERSHIP' && binding.text === ownership) &&
    bindings.some((binding) => binding.name === 'SOURCE_COMMIT' && binding.text === commit)
  );
}
export async function runProofWithCleanup(
  execute: () => Promise<void>,
  cleanup: () => Promise<Error | undefined>
): Promise<void> {
  let originalFailure: unknown;
  let failed = false;
  try {
    await execute();
  } catch (error) {
    failed = true;
    originalFailure = error;
  }
  let cleanupFailure: unknown;
  try {
    cleanupFailure = await cleanup();
  } catch (error) {
    cleanupFailure = error;
  }
  if (failed) throw originalFailure;
  if (cleanupFailure) throw cleanupFailure;
}

export async function runProof(): Promise<void> {
  if (process.env.INSTALLER_ENVIRONMENT !== 'staging') throw new Error('Staging proof only');
  if (process.env.SAM_INSTALLER_PAID_PROOF !== 'one-cold-build-60-minutes')
    throw new Error('Explicit bounded paid proof invocation required');
  const token = process.env.CF_API_TOKEN;
  const account = process.env.CF_ACCOUNT_ID;
  const commit = process.env.SAM_PROOF_SOURCE_COMMIT;
  if (!token || !/^[a-f0-9]{32}$/.test(account ?? '') || !/^[a-f0-9]{40}$/.test(commit ?? ''))
    throw new Error('Staging deployment credentials and immutable source commit required');
  const name = `sam-build-proof-${randomBytes(6).toString('hex')}`;
  const key = randomBytes(32).toString('hex');
  const ownership = createHash('sha256').update(key).digest('hex');
  const base = `/accounts/${account}`;
  let applicationId: string | undefined;
  let workerCreated = false;
  let applicationAttempted = false;
  let startAttempted = false;
  let endpoint: string | undefined;
  const api = async (path: string, method = 'GET', body?: unknown): Promise<any> => {
    const multipart = body instanceof FormData;
    const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(!multipart ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : multipart ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const result = (await response.json()) as { success?: boolean; result?: unknown };
    if (!response.ok || result.success === false)
      throw Object.assign(
        new Error(`Proof API ${method} failed (${response.status}); private response withheld`),
        { status: response.status }
      );
    return result.result;
  };
  const control = async (path: string, method = 'GET') => {
    const response = await fetch(`${endpoint}${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Proof control failed (${response.status})`);
    return (await response.json()) as { status: string; fit?: { phase?: string } };
  };
  console.log(
    JSON.stringify({
      proof: name,
      sourceCommit: commit,
      instance: PROOF_INSTANCE,
      deadlineSeconds: PROOF_SECONDS,
      computeUpperUsd: PROOF_COMPUTE_UPPER_USD,
      conservativeIncrementalBudgetUsd: 2,
    })
  );
  const pollProof = async () => {
    const deadline = Date.now() + (PROOF_SECONDS + 60) * 1000;
    let last = '';
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 15000));
      const state = await control('/status');
      const line = JSON.stringify(state);
      if (line !== last) {
        console.log(line);
        last = line;
      }
      if (state.status !== 'running') {
        if (state.status !== 'completed' || state.fit?.phase !== 'completed')
          throw new Error(`Cold build proof ${state.status}; see last bounded phase evidence`);
        return;
      }
    }
    throw new Error('Launcher deadline reached; cancelling proof');
  };
  const executeProof = async () => {
    const subdomain = (await api(`${base}/workers/subdomain`)) as { subdomain?: string };
    if (!subdomain.subdomain) throw new Error('Staging workers.dev subdomain required');
    endpoint = `https://${name}.${subdomain.subdomain}.workers.dev`;
    // Establish absence before upload; cleanup later checks our ownership marker.
    try {
      await api(`${base}/workers/scripts/${name}/settings`);
      throw new Error('Proof resource name collision');
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
    }
    const applications = (await api(`${base}/containers/applications`)) as { name: string }[];
    if (applications.some((application) => application.name === name))
      throw new Error('Proof application name collision');
    const body = new FormData();
    body.set(
      'metadata',
      new Blob(
        [
          JSON.stringify({
            main_module: 'proof.js',
            compatibility_date: '2026-10-01',
            containers: [{ class_name: 'BuildProof' }],
            migrations: { new_tag: 'v1', new_sqlite_classes: ['BuildProof'] },
            bindings: [
              { type: 'durable_object_namespace', name: 'PROOF', class_name: 'BuildProof' },
              { type: 'secret_text', name: 'PROOF_KEY', text: key },
              { type: 'plain_text', name: 'SOURCE_COMMIT', text: commit },
              { type: 'plain_text', name: 'PROOF_OWNERSHIP', text: ownership },
            ],
          }),
        ],
        { type: 'application/json' }
      )
    );
    body.set(
      'proof.js',
      new Blob([proofWorkerSource()], { type: 'application/javascript+module' }),
      'proof.js'
    );
    workerCreated = true;
    await api(`${base}/workers/scripts/${name}`, 'PUT', body);
    applicationAttempted = true;
    const app = (await api(`${base}/containers/applications`, 'POST', {
      name,
      scheduling_policy: 'durable_object',
      durable_objects: { script_name: name, class_name: 'BuildProof' },
      observability: { logs: { enabled: false } },
    })) as { id: string };
    applicationId = app.id;
    await api(`${base}/workers/scripts/${name}/subdomain`, 'POST', { enabled: true });
    // Readiness retries never start compute. There is exactly one /start request.
    let ready = false;
    for (let n = 0; n < 12; n++) {
      try {
        await control('/status');
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
    if (!ready) throw new Error('Proof Worker did not propagate');
    startAttempted = true;
    await control('/start', 'POST');
    await pollProof();
  };
  const verifyOwnership = async () => {
    let ownershipVerified = !workerCreated;
    if (workerCreated) {
      try {
        ownershipVerified = ownsProofWorker(
          await api(`${base}/workers/scripts/${name}/settings`),
          ownership,
          commit!
        );
      } catch (error) {
        ownershipVerified = (error as { status?: number }).status === 404;
      }
    }

    return ownershipVerified;
  };
  const deleteProofWorker = async (errors: string[]) => {
    try {
      await api(`${base}/workers/scripts/${name}?force=true`, 'DELETE');
    } catch (error) {
      if ((error as { status?: number }).status !== 404) errors.push(`worker:${name}`);
    }
  };
  const cancelProof = async (errors: string[]) => {
    try {
      await control('/cancel', 'POST');
    } catch {
      errors.push('cancel');
    }
  };
  const reconcileProofApplication = async (errors: string[]) => {
    try {
      const applications = (await api(`${base}/containers/applications`)) as {
        id: string;
        name: string;
      }[];
      applicationId = applications.find((application) => application.name === name)?.id;
    } catch {
      errors.push(`reconcile-application:${name}`);
    }
  };
  const cleanupProof = async (): Promise<Error | undefined> => {
    const errors: string[] = [];
    const ownershipVerified = await verifyOwnership();
    if (!ownershipVerified) errors.push(`ownership:${name}`);

    if (endpoint && startAttempted && ownershipVerified) await cancelProof(errors);
    if (applicationAttempted && !applicationId && ownershipVerified) {
      await reconcileProofApplication(errors);
    }
    if (applicationId && ownershipVerified) {
      try {
        await api(`${base}/containers/applications/${applicationId}`, 'DELETE');
      } catch {
        errors.push(`application:${applicationId}`);
      }
    }
    if (workerCreated && ownershipVerified) await deleteProofWorker(errors);
    if (errors.length) {
      console.error(`Proof cleanup needs attention: ${errors.join(', ')}`);
      return new Error('Proof cleanup incomplete');
    }
    console.log(`Deleted only proof resources ${name}`);
    return undefined;
  };
  await runProofWithCleanup(executeProof, cleanupProof);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runProof().catch(() => {
    console.error(
      'Cold build proof failed; check bounded phase and cleanup evidence. Credentials and full tool logs withheld; credential-free failure tail is limited to 4 KiB.'
    );
    process.exitCode = 1;
  });
