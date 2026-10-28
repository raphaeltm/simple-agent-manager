// Small, dependency-free module uploaded to the owner's account. No cloud credential
// is embedded: this prototype proves ownership handoff, not ongoing deployment authority.
export const maintenanceSource = `
const headers = {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
async function hash(value) {return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join('');}
export default {async fetch(request,env){
 const url=new URL(request.url);
 if(url.pathname==='/health')return Response.json({ok:true,kind:'sam-maintenance-prototype'});
 if(request.method==='POST' && url.pathname==='/claim'){
  if(request.headers.get('Origin')!==env.INSTALLER_ORIGIN)return new Response('Forbidden',{status:403});
  const body=await request.formData();
  const key=body.get('key');
  if(Date.now()>Number(env.CLAIM_EXPIRES)||typeof key!=='string'||await hash(key)!==env.OWNER_KEY_HASH)return new Response('This handoff has expired. Return to the installer.',{status:403});
  return new Response(null,{status:303,headers:{...headers,Location:'/', 'Set-Cookie':'__Host-sam-maintenance='+key+'; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=900'}});
 }
 const key=request.headers.get('Cookie')?.split(';').map(x=>x.trim()).find(x=>x.startsWith('__Host-sam-maintenance='))?.split('=')[1];
 if(!key||Date.now()>Number(env.CLAIM_EXPIRES)||await hash(key)!==env.OWNER_KEY_HASH)return new Response('Open this service through your installer handoff. This prototype has no public administration endpoint.',{status:401,headers});
 return new Response('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your SAM installation service</title><style>html{color-scheme:dark}*{box-sizing:border-box}body{font:15px/1.8 system-ui;max-width:44rem;margin:10vh auto;padding:28px;background:radial-gradient(ellipse at top left,#10291c,#070d0b 70%);color:#e6f2ee}main{padding:clamp(22px,5vw,42px);border:1px solid #29423b;border-radius:20px;background:linear-gradient(140deg,#18261f,#0b1110);box-shadow:0 24px 64px #0005}h1{font-size:clamp(28px,6vw,40px);letter-spacing:-1px;line-height:1.2;margin:22px 0}p{color:#9fb7ae}strong{color:#86efac}.badge{display:inline-block;padding:5px 12px;border:1px solid #2b6540;border-radius:30px;color:#86efac;font-size:12px}code{overflow-wrap:anywhere}@media(max-width:400px){body{margin:4vh auto;padding:18px}}</style><main><span class="badge">✓ Ownership verified</span><h1>Your account. Your installation service.</h1><p><strong>Ownership handoff verified.</strong> This Worker runs in your Cloudflare account.</p><p>This is the installer prototype. Building SAM, installing its databases, and version updates are not connected yet. No ongoing Cloudflare deployment credential is stored here.</p><p>Your temporary owner session expires shortly. You can inspect or delete this Worker in your Cloudflare dashboard.</p></main></html>',{headers});
}};
`;
