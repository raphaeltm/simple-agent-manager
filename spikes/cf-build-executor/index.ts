// SPIKE ONLY — arbitrary exec endpoint authenticated with a throwaway secret.
import { getSandbox } from '@cloudflare/sandbox';
export { Sandbox } from '@cloudflare/sandbox';
export default {
 async fetch(request: Request, env: any): Promise<Response> {
  if (!env.SPIKE_KEY || request.headers.get('Authorization') !== `Bearer ${env.SPIKE_KEY}`) return new Response('unauthorized', {status:401});
  const url = new URL(request.url);
  if(url.pathname === '/version') return new Response('spike2-a-sdk-0.12.14');
  if (request.method !== 'POST') return new Response('POST required', {status:405});
  const id = url.searchParams.get('id');
  if (!id) return new Response('fresh id required', {status:400});
  const sandbox = getSandbox(env.Sandbox, id, {sleepAfter:'2m'});
  try {
   if(url.pathname === '/destroy') {await sandbox.destroy(); return Response.json({destroyed:true});}
   const body: any = await request.json();
   const started=Date.now();
   const result=await sandbox.exec(body.command, {timeout:body.timeoutMs ?? 90000});
   return Response.json({wallMs:Date.now()-started,...result});
  } catch(e) {return Response.json({error:String(e)}, {status:503});}
 }
};
