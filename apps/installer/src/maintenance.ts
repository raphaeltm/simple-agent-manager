import { maintenanceBrand } from './maintenance-brand.generated';
import { maintenanceJobsSource } from './maintenance-jobs';

// This dependency-free module runs entirely in the owner's account. Its coordinator
// persists ownership independently of the hosted bootstrap grant and claim lifetime.
export const maintenanceSource = `
const COOKIE='__Host-sam-maintenance';
const headers={'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",'Referrer-Policy':'strict-origin','X-Content-Type-Options':'nosniff'};
async function hash(value){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join('');}
function random(){return [...crypto.getRandomValues(new Uint8Array(32))].map(x=>x.toString(16).padStart(2,'0')).join('');}
function equal(a,b){if(typeof a!=='string'||typeof b!=='string')return false;let n=a.length^b.length;for(let i=0;i<Math.max(a.length,b.length);i++)n|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);return n===0;}
function escape(value){return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function page(content,status=200,cookie){const h={...headers};if(cookie)h['Set-Cookie']=cookie;h['Content-Security-Policy'] += "; script-src ${maintenanceBrand.scriptHashes}";content=content.replace(/class="badge"/g,'class="hero-badge sam-glass sam-glass--chrome sam-glass-rim"').replace(/<button(?![^>]*class=)/g,'<button class="sam-btn sam-btn--primary"').replace(/class="secondary"/g,'class="sam-btn sam-btn--secondary"').replace(/class="primary-link"/g,'class="sam-btn sam-btn--primary"');return new Response(${JSON.stringify(maintenanceBrand.before)}+content+${JSON.stringify(maintenanceBrand.after)},{status,headers:h});}
function cookie(value,age){return COOKIE+'='+value+'; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age='+age;}
function positive(value,fallback,max){const n=Number(value);return Number.isInteger(n)&&n>0&&n<=max?n:fallback;}
function sessionTtl(env){const value=Number(env.OWNER_SESSION_TTL_SECONDS||86400);return Number.isInteger(value)&&value>=60&&value<=2592000?value:86400;}
function recoveryForm(message=''){return '<span class="badge">Your account. Your service.</span><h1>Open your installation service</h1><p>'+escape(message||'Use the recovery credential saved when you claimed this service. Your Cloudflare deployment credentials are never used to sign in here.')+'</p><form method="post" action="/recover"><label for="recovery">Recovery credential</label><input id="recovery" name="recovery" type="password" autocomplete="off" required maxlength="128"><button>Sign in</button></form>';}
function ownerPage(recovery){return '<span class="badge">Ownership verified</span><h1>Your account. Your installation service.</h1><p><strong>Ownership handoff verified.</strong> This Worker and its durable ownership record run in your Cloudflare account.</p>'+(recovery?'<h2>Save your recovery credential</h2><p>This is shown once. Save it in your password manager before leaving. It lets you return after this browser session expires, independently of the hosted installer.</p><code>'+escape(recovery)+'</code><p>Keep this credential private. Anyone holding it can administer this installation service.</p>':'')+'<p><a href="/">Continue to installation controls →</a></p><hr><p>Building SAM, installing its databases, and version updates are not connected yet. No ongoing Cloudflare deployment credential is stored here.</p><form method="post" action="/rotate"><p>Replace your recovery credential if it has been exposed. This invalidates the previous credential and all previous sessions.</p><button>Replace recovery credential</button></form><form method="post" action="/logout"><button>Sign out</button></form>';}
export class MaintenanceCoordinator{
 constructor(state,env){this.state=state;this.env=env;this.queue=Promise.resolve();}
 async fetch(request){const run=this.queue.then(()=>this.handle(request));this.queue=run.catch(()=>undefined);try{return await run;}catch{return page('<h1>Unable to complete this request</h1><p>Retry from this service. No credentials were logged.</p>',500);}}
 async handle(request){
  const url=new URL(request.url),path=url.pathname,now=Date.now();
  if(path==='/health'&&request.method==='GET')return Response.json({ok:true,kind:'sam-maintenance',deploymentConfigured:!!this.env.INSTALLATION_CONFIG},{headers:{'Cache-Control':'no-store'}});
  if(!['/','/claim','/recover','/rotate','/confirm-rotate','/logout','/deploy','/resume','/cancel','/setup','/update-preview','/update'].includes(path))return page('<h1>Not found</h1>',404);
  if(request.method!=='GET'&&request.method!=='POST')return page('<h1>Method not allowed</h1>',405);
  if(request.method==='POST'){
   const expected=path==='/claim'?this.env.INSTALLER_ORIGIN:url.origin;
   if(request.headers.get('Origin')!==expected)return page('<h1>Forbidden</h1>',403);
  }
  if(path!=='/'&&request.method!=='POST')return page('<h1>Method not allowed</h1>',405);
  let body;
  if(request.method==='POST'){
   if(Number(request.headers.get('Content-Length')||0)>4096)return page('<h1>Request too large</h1>',413);
   const reader=request.body?.getReader();let length=0,chunks=[];
   if(reader){while(true){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>4096){await reader.cancel();return page('<h1>Request too large</h1>',413);}chunks.push(part.value);}}
   const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
   if(!(request.headers.get('Content-Type')||'').startsWith('application/x-www-form-urlencoded'))return page('<h1>Unsupported form</h1>',415);
   body=new URLSearchParams(new TextDecoder().decode(bytes));
  }
  let owner=await this.state.storage.get('owner');
  if(path==='/claim'){
   const key=body.get('key');
   if(owner)return page('<h1>Already claimed</h1><p>Use your saved recovery credential to sign in at this service.</p>',409);
   if(!Number.isFinite(Number(this.env.CLAIM_EXPIRES))||now>=Number(this.env.CLAIM_EXPIRES)||typeof key!=='string'||key.length>128||!equal(await hash(key),this.env.OWNER_KEY_HASH))return page('<h1>This handoff has expired or is invalid</h1><p>Return to the installer. An unclaimed service cannot be administered publicly.</p>',403);
   const submittedRecovery=body.get('recovery');
   if(this.env.CLIENT_RECOVERY_REQUIRED==='true'&&(typeof submittedRecovery!=='string'||!/^[a-f0-9]{64}$/.test(submittedRecovery)))return page('<h1>Save a recovery credential first</h1><p>Return to the handoff page and save its browser-generated recovery credential before claiming this service.</p>',400);
   if(submittedRecovery!==null&&(typeof submittedRecovery!=='string'||!/^[a-f0-9]{64}$/.test(submittedRecovery)))return page('<h1>Invalid recovery credential</h1>',400);
   const recovery=submittedRecovery||random(),session=random(),ttl=sessionTtl(this.env);
   const record={recoveryHash:await hash(recovery),sessionHash:await hash(session),sessionExpires:now+ttl*1000,claimedAt:now};
   const claimed=await this.state.storage.transaction(async storage=>{if(await storage.get('owner'))return false;await storage.put('owner',record);return true;});
   if(!claimed)return page('<h1>Already claimed</h1>',409);
   return page((this.env.INSTALLATION_CONFIG?ownerPage(recovery).replace('Building SAM, installing its databases, and version updates are not connected yet. No ongoing Cloudflare deployment credential is stored here.','Your installation settings are ready. Continue to installation controls to approve the build.'):ownerPage(recovery)),200,cookie(session,ttl));
  }
  if(!owner)return page('<h1>Not claimed</h1><p>Open this service using the installer handoff. Public recovery is unavailable until ownership is established.</p>',401);
  if(path==='/recover'){
   const windowSeconds=positive(this.env.OWNER_RECOVERY_WINDOW_SECONDS,900,86400),maxAttempts=positive(this.env.OWNER_RECOVERY_MAX_ATTEMPTS,10,100);
   let attempts=await this.state.storage.get('recoveryAttempts');
   if(!attempts||now-attempts.started>=windowSeconds*1000)attempts={started:now,count:0};
   if(attempts.count>=maxAttempts)return page(recoveryForm('Too many recovery attempts. Try again after the recovery rate-limit window.'),429);
   attempts.count++;await this.state.storage.put('recoveryAttempts',attempts);
   const credential=body.get('recovery');
   if(typeof credential!=='string'||credential.length>128||!equal(await hash(credential),owner.recoveryHash))return page(recoveryForm('The recovery credential is invalid.'),401);
   const session=random(),ttl=sessionTtl(this.env);owner.sessionHash=await hash(session);owner.sessionExpires=now+ttl*1000;
   await this.state.storage.put('owner',owner);await this.state.storage.delete('recoveryAttempts');
   return page((this.env.INSTALLATION_CONFIG?ownerPage().replace('Building SAM, installing its databases, and version updates are not connected yet. No ongoing Cloudflare deployment credential is stored here.','Your installation service is ready. Continue to installation controls to view progress.'):ownerPage()),200,cookie(session,ttl));
  }
  const token=request.headers.get('Cookie')?.split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);
  if(!token||token.length>128||now>=owner.sessionExpires||!equal(await hash(token),owner.sessionHash))return page(recoveryForm(),401);
  if(['/deploy','/resume','/cancel','/setup','/update-preview','/update'].includes(path))return maintenanceJobAction(this,path,body);
  if(path==='/logout'){owner.sessionHash='';owner.sessionExpires=0;await this.state.storage.put('owner',owner);return page(recoveryForm('You have signed out.'),200,cookie('',0));}
  if(path==='/rotate'){
   const recovery=random(),rotation=random(),seconds=positive(this.env.OWNER_ROTATION_TTL_SECONDS,900,3600);
   owner.pendingRecovery={hash:await hash(recovery),id:rotation,expires:now+seconds*1000};
   await this.state.storage.put('owner',owner);
   return page('<h1>Save your new recovery credential</h1><p>Your current recovery credential remains valid until you confirm. Save the new value in your password manager first.</p><code>'+escape(recovery)+'</code><form method="post" action="/confirm-rotate"><input type="hidden" name="rotation" value="'+rotation+'"><label><input type="checkbox" name="saved" value="yes" required> I saved the new recovery credential.</label><button>Confirm replacement</button></form><p><a href="/">Keep my current credential</a></p>');
  }
  if(path==='/confirm-rotate'){
   const pending=owner.pendingRecovery;
   if(!pending||pending.expires<=now||body.get('saved')!=='yes'||!equal(body.get('rotation'),pending.id))return page('<h1>Review the replacement again</h1><p>No recovery credential was changed. Return to maintenance to begin a new replacement.</p>',409);
   const session=random(),ttl=sessionTtl(this.env);
   owner.recoveryHash=pending.hash;delete owner.pendingRecovery;
   owner.sessionHash=await hash(session);owner.sessionExpires=now+ttl*1000;
   await this.state.storage.put('owner',owner);await this.state.storage.delete('recoveryAttempts');
   return page('<h1>Recovery credential replaced</h1><p>Your saved new credential is now active. The previous credential and previous browser sessions have been revoked.</p><p><a href="/">Continue to installation controls →</a></p>',200,cookie(session,ttl));
  }
  if(this.env.INSTALLATION_CONFIG)return page(await maintenanceDeploymentPanel(this)+'<details class="access-details"><summary>Access & recovery</summary><p>This service and your recovery credential are independent of the hosted installer. Recovery sign-in replaces the previous active session.</p><form method="post" action="/rotate"><button class="secondary">Replace recovery credential</button></form><form method="post" action="/logout"><button class="secondary">Sign out</button></form></details>');
  return page(ownerPage());
 }
}
export default {async fetch(request,env){const stub=env.MAINTENANCE.get(env.MAINTENANCE.idFromName('owner'));return stub.fetch(request);}};
${maintenanceJobsSource}
`;
