import {Container,getContainer} from '@cloudflare/containers';
export class BuildSpike extends Container {
 defaultPort=8080;
 sleepAfter='2m';
 enableInternet=true;
 async diagnose(){
 if(!this.ctx.container.running) await this.start();
 const p=await this.ctx.container.exec(['sh','-c','id; ps; cat /driver.py; cat /proc/1/fd/3; cat /root/dockerd.log; timeout 5 docker info; netstat -lntp; cat /proc/1/wchan']);const o=await p.output();return {exitCode:o.exitCode,stdout:new TextDecoder().decode(o.stdout),stderr:new TextDecoder().decode(o.stderr)};
 }
 async fetch(request:Request):Promise<Response>{
  if(new URL(request.url).pathname==='/stop'){await this.stop();return new Response('stopped');}
  if(new URL(request.url).pathname==='/diag'){
   if(!this.ctx.container.running) await this.start();
   const p=await this.ctx.container.exec(['sh','-c','id; ps; cat /driver.py; cat /proc/1/fd/3; cat /root/dockerd.log; timeout 5 docker info; netstat -lntp; cat /proc/1/wchan; wget -qO- http://127.0.0.1:8080/']);
   const o=await p.output();return Response.json({exitCode:o.exitCode,stdout:new TextDecoder().decode(o.stdout),stderr:new TextDecoder().decode(o.stderr)});
  }
  return super.fetch(request);
 }
}
export default {async fetch(request:Request,env:any):Promise<Response>{
 if(request.headers.get('Authorization')!==`Bearer ${env.SPIKE_KEY}`) return new Response('unauthorized',{status:401});
 const url=new URL(request.url);const id=url.searchParams.get('id')||'probe';
 if(url.pathname==='/destroy'){await getContainer(env.BUILD,id).destroy();return new Response('destroyed');}
 if(url.pathname==='/kill'){await getContainer(env.BUILD,id).stop('SIGKILL');return new Response('killed');}
 if(url.pathname==='/version')return new Response('spike-v4');
 if(url.pathname==='/rpcdiag'){try{return Response.json(await getContainer(env.BUILD,id).diagnose());}catch(e){return Response.json({error:String(e)},{status:503});}}
 try{return await getContainer(env.BUILD,id).fetch(request);}catch(e){return Response.json({name:e.name,message:e.message,stack:e.stack},{status:503});}
}};
