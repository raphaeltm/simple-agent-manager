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
 return new Response('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your SAM installation service</title><style>body{font:18px system-ui;max-width:44rem;margin:10vh auto;padding:24px;background:#111827;color:#e5e7eb;line-height:1.6}h1{line-height:1.2}strong{color:#93c5fd}</style><h1>Your account. Your installation service.</h1><p><strong>Ownership handoff verified.</strong> This Worker runs in your Cloudflare account.</p><p>This is the installer prototype. Building SAM, installing its databases, and version updates are not connected yet. No ongoing Cloudflare deployment credential is stored here.</p><p>Your temporary owner session expires shortly. You can inspect or delete this Worker in your Cloudflare dashboard.</p></html>',{headers});
}};
`;
