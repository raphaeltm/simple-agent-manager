// Appended to the dependency-free owner-account module. All entrypoints are
// reached only after MaintenanceCoordinator's owner/session and origin checks.
export const maintenanceJobsSource = String.raw`
async function maintenanceBuilder(service,path,body){
 const stub=service.env.BUILDER.get(service.env.BUILDER.idFromName('installation'));
 const response=await stub.fetch(new Request('https://builder'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+service.env.BUILDER_CONTROL_SECRET,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}));
 const value=await response.json();if(!response.ok)throw new Error('Builder request failed');return value;
}
async function maintenanceManifest(service){
 let manifest=await service.state.storage.get('installation');if(manifest)return manifest;
 const config=JSON.parse(service.env.INSTALLATION_CONFIG||'null');if(!config)return null;
 if(config.accountId!==service.env.CF_ACCOUNT_ID||!/^[a-f0-9]{40}$/.test(config.sourceCommit))throw new Error('Invalid installation manifest');
 manifest={config,sourceMode:'upstream',createdAt:Date.now()};await service.state.storage.put('installation',manifest);return manifest;
}

function maintenanceMatches(manifest,job){return !!manifest.requestedJob&&job.jobId===manifest.requestedJob.id&&job.sourceCommit===manifest.requestedJob.config.sourceCommit;}
async function maintenanceReconcile(service,manifest){
 let job=await maintenanceBuilder(service,'/status');const request=manifest.requestedJob;
 if(request?.cancelledBeforeStart&&!request.accepted)return {jobId:request.id,sourceCommit:request.config.sourceCommit,status:'cancelled'};
 if(request&&!request.accepted){
  if(!maintenanceMatches(manifest,job)){
   if(['starting','running'].includes(job.status))throw new Error('Unrelated active builder job');
   await maintenanceBuilder(service,'/start',request.config);job=await maintenanceBuilder(service,'/status');
  }
  if(!maintenanceMatches(manifest,job))throw new Error('Builder did not accept approved job');
  request.accepted=true;await service.state.storage.put('installation',manifest);
 }
 if(job.status==='completed'&&maintenanceMatches(manifest,job)&&manifest.lastSuccessfulCommit!==job.sourceCommit){manifest.lastSuccessfulCommit=job.sourceCommit;manifest.updatedAt=Date.now();await service.state.storage.put('installation',manifest);}
 return job;
}

async function maintenanceDeploymentPanel(service){
 const manifest=await maintenanceManifest(service);if(!manifest)return '';
 const job=await maintenanceReconcile(service,manifest);
 if(job.status==='completed'&&maintenanceMatches(manifest,job)&&manifest.lastSuccessfulCommit!==job.sourceCommit){manifest.lastSuccessfulCommit=job.sourceCommit;manifest.updatedAt=Date.now();await service.state.storage.put('installation',manifest);}
 const active=['starting','running'].includes(job.status),retry=['failed','interrupted','timed_out','cancelled'].includes(job.status);
 const config=manifest.config;
 const phases={'preflight':'Checking source and account','codex-source-build':'Building the agent runtime','state':'Preparing persistent state','infrastructure':'Creating your infrastructure','configure-services':'Configuring Cloudflare services','build':'Building SAM','migrations':'Checking database migrations','publish-agent-artifacts':'Publishing agent artifacts','bootstrap-api-tail':'Starting the control plane','publish-application':'Publishing SAM','publish-cli':'Publishing the CLI','health':'Checking your installation'};
 const detail=job.checkpoint?.activePhase?(phases[job.checkpoint.activePhase]||'Working on your installation'):'';
 const status={idle:'Ready to install',starting:'Starting your build',running:'Installation in progress',completed:'SAM is ready',failed:'Installation needs attention',interrupted:'Build interrupted',timed_out:'Build reached its time limit',cancelled:'Build cancelled'}[job.status]||'Checking status';
 return '<section class="deployment"><span class="badge">Your installation</span><h1>'+escape(config.baseDomain)+'</h1><div class="deployment-status"><strong>'+escape(status)+'</strong>'+(detail&&job.status!=='completed'?'<p>'+escape(detail)+'</p>':'')+'</div>'+(active?'<p>Your build is running in your Cloudflare account. You can close this browser and return here later.</p><form method="get" action="/"><button class="secondary">Refresh progress</button></form><form method="post" action="/cancel"><button class="secondary">Cancel deployment</button></form>':retry?'<p>Your installation and build artifacts are preserved. Retry reconciles the approved deployment. Database recovery is separate from code rollback.</p><form method="post" action="/resume"><button>Retry deployment</button></form><form method="get" action="/"><button class="secondary">Refresh progress</button></form>':!manifest.lastSuccessfulCommit?'<p>Build SAM in your account, then open your own instance. This creates databases, storage, application images and the DNS records you reviewed. Workers Paid and usage charges apply.</p><form method="post" action="/deploy"><label><input name="confirmed" type="checkbox" value="yes" required> Build and deploy this approved installation.</label><button>Install SAM</button></form>':'<p>Your instance passed its deployment health check. Continue to configure sign-in and finish setup.</p><form method="post" action="/setup"><button>Open initial setup instructions</button></form><form method="post" action="/update-preview"><button class="secondary">Check for an update</button></form>')+'<details><summary>Installation details</summary><p>Administrator: '+escape(config.ownerEmail)+'</p><p>Approved source</p><code>'+escape(config.sourceCommit)+'</code><p>Account: '+escape(config.accountId)+'<br>Zone: '+escape(config.zoneName)+'</p></details></section>';

}
async function maintenanceJobAction(service,path,body){
 const manifest=await maintenanceManifest(service);if(!manifest)return page('<h1>Deployment is not configured</h1>',409);
 // Cancellation must never reconcile a queued request by starting paid compute.
 if(path==='/cancel'){
  const observed=await maintenanceBuilder(service,'/status'),request=manifest.requestedJob;
  if(request&&!request.accepted&&!maintenanceMatches(manifest,observed)){
   request.cancelledBeforeStart=true;await service.state.storage.put('installation',manifest);
   return new Response(null,{status:303,headers:{Location:'/'}});
  }
  if(!maintenanceMatches(manifest,observed))return page('<h1>Job does not match this installation approval</h1>',409);
  if(!['starting','running'].includes(observed.status))return page('<h1>No active deployment to cancel</h1>',409);
  if(!request.accepted){request.accepted=true;await service.state.storage.put('installation',manifest);}
  await maintenanceBuilder(service,'/cancel',{});return new Response(null,{status:303,headers:{Location:'/'}});
 }
 if(path==='/resume'&&manifest.requestedJob?.cancelledBeforeStart&&!manifest.requestedJob.accepted){
  delete manifest.requestedJob.cancelledBeforeStart;await service.state.storage.put('installation',manifest);
  await maintenanceReconcile(service,manifest);return new Response(null,{status:303,headers:{Location:'/'}});
 }
 let job=await maintenanceReconcile(service,manifest);
 if(path==='/setup'){
  if(job.status!=='completed'||!maintenanceMatches(manifest,job))return page('<h1>Finish the approved deployment first</h1>',409);
  const result=await maintenanceBuilder(service,'/result');
  if(typeof result.setupToken!=='string'||result.appUrl!=='https://app.'+manifest.config.baseDomain)return page('<h1>Setup handoff unavailable</h1>',409);
  return page('<h1>Finish setting up SAM</h1><p>Open your instance and enter this setup token. Then configure a supported sign-in provider and sign in using the verified email <strong>'+escape(manifest.config.ownerEmail)+'</strong>. Other visitors cannot claim the initial administrator.</p><code>'+escape(result.setupToken)+'</code><p><a class="primary-link" href="'+escape(result.appUrl)+'/setup" rel="noreferrer">Open SAM setup →</a></p><p><a href="/">Return to maintenance</a></p>');
 }
 if(path==='/resume'){if(!maintenanceMatches(manifest,job))return page('<h1>Job does not match this installation approval</h1>',409);}
 if(path==='/resume'){await maintenanceBuilder(service,'/resume',{jobId:job.jobId});return new Response(null,{status:303,headers:{Location:'/'}});}
 if(path==='/update-preview'){
  if(job.status!=='completed'||!maintenanceMatches(manifest,job)||manifest.sourceMode!=='upstream'||manifest.customSource)return page('<h1>Update unavailable</h1><p>Finish the existing deployment or preserve custom source changes before updating.</p>',409);
  const headers={'User-Agent':'SAM-owner-maintenance','Accept':'application/vnd.github+json'};
  const releaseResponse=await fetch('https://api.github.com/repos/raphaeltm/simple-agent-manager/releases/latest',{headers,signal:AbortSignal.timeout(10000)});
  if(!releaseResponse.ok)return page('<h1>Could not check releases</h1><p>Your current installation has not changed. Retry later.</p>',502);
  const release=await releaseResponse.json();if(typeof release.tag_name!=='string'||release.tag_name.length>128)throw new Error('Invalid upstream release');
  const response=await fetch('https://api.github.com/repos/raphaeltm/simple-agent-manager/commits/'+encodeURIComponent(release.tag_name),{headers,signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw new Error('Release source unavailable');const commit=await response.json();if(!/^[a-f0-9]{40}$/.test(commit.sha))throw new Error('Invalid release source');
  if(commit.sha===manifest.lastSuccessfulCommit)return page('<h1>You are up to date</h1><p><a href="/">Return to maintenance</a></p>');
  const approval=random();manifest.pendingUpdate={sourceCommit:commit.sha,approvalHash:await hash(approval),expires:Date.now()+900000};await service.state.storage.put('installation',manifest);
  return page('<h1>Review your update</h1><p>Release '+escape(release.tag_name)+'<code>'+escape(commit.sha)+'</code> will be built in your account. Databases pass the same migration safety checks. This is a code update, not a database rollback.</p><form method="post" action="/update"><input type="hidden" name="approval" value="'+approval+'"><button>Approve and deploy this version</button></form><p><a href="/">Keep current version</a></p>');
 }
 if(path==='/deploy'||path==='/update'){
  if(['starting','running'].includes(job.status))return page('<h1>A deployment is already running</h1>',409);
  let source=manifest.config.sourceCommit;
  if(path==='/deploy'&&(body.get('confirmed')!=='yes'||manifest.lastSuccessfulCommit))return page('<h1>Confirm the first installation</h1>',409);
  if(path==='/update'){
   const pending=manifest.pendingUpdate;if(!pending||pending.expires<=Date.now()||await hash(body.get('approval')||'')!==pending.approvalHash||manifest.sourceMode!=='upstream'||manifest.customSource)return page('<h1>Review the update again</h1>',409);
   source=pending.sourceCommit;delete manifest.pendingUpdate;
  }
  const prefix='s'+(await hash(manifest.config.baseDomain)).slice(0,6),jobId=random().slice(0,32);
  const config={...manifest.config,sourceCommit:source,prefix,environment:'production',jobId,...(manifest.lastSuccessfulCommit?{previousSourceCommit:manifest.lastSuccessfulCommit}:{})};
  manifest.config.sourceCommit=source;manifest.requestedJobId=jobId;manifest.requestedJob={id:jobId,config,accepted:false};await service.state.storage.put('installation',manifest);
  await maintenanceReconcile(service,manifest);
  return new Response(null,{status:303,headers:{Location:'/'}});
 }
 return page('<h1>Not found</h1>',404);
}
`;
