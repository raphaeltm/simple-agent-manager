// Verification only: fixed historical session/delivery; MUST use reviewed safe-controller supervisor.
import {writeFile} from 'node:fs/promises';
const session='675e6493-dd46-49e3-85a5-54d6b58ef6be';
const project='01KJNR9R3TEN3KX1ETE33852R8';
const delivery='01M50QD5KWSD1Q7D1EX4PJK387';
const api='https://api.sammy.party';
const before=Date.parse('2026-10-15T21:33:28Z');
const types=['prompt_delivery.accepted','prompt_delivery.retry','prompt_delivery.failed','prompt_delivery.ambiguous'];
const reasons={accepted:new Set(),retry:new Set(['busy','not_ready','receipt_not_found']),
  failed:new Set(['terminal_target','dead_target','wake_refused','unsupported_capability','delivery_conflict']),
  ambiguous:new Set(['lost_response','runtime_changed','receipt_unavailable'])};
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const id=value=>typeof value==='string'&&(/^[0-9A-HJKMNP-TV-Z]{26}$/.test(value)||/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value));
export function projectHistoryPage(value,type){
  // Never advance a timestamp-only cursor: it could omit equal-ms rows. Truncation fails closed.
  if(!types.includes(type)||!value||value.hasMore!==false||!Array.isArray(value.events)||value.events.length>100)return null;
  const seen=new Set(),events=[];let previous=before;
  for(const row of value.events){
    if(!row||!id(row.id)||seen.has(row.id)||row.sessionId!==session||row.eventType!==type
      ||!integer(row.createdAt)||row.createdAt>=before||row.createdAt>previous)return null;
    seen.add(row.id);previous=row.createdAt;
    const payload=row.payload;
    if(!payload||typeof payload!=='object'||Array.isArray(payload)||!id(payload.deliveryId))return null;
    if(payload.deliveryId!==delivery)continue;
    const kind=type.slice('prompt_delivery.'.length);
    if(payload.result!==kind||!id(payload.attemptId)||!integer(payload.attemptCount)||payload.attemptCount<1
      ||!['submit','reconcile'].includes(payload.mode)||!(payload.reason===null||typeof payload.reason==='string'))return null;
    const times={};
    for(const key of ['userMessageAt','preparationStartedAt','resultAppliedAt','runtimeAcceptedAt','wakeReadyAt']){
      if(payload[key]!==null&&!integer(payload[key]))return null;
      times[key]=payload[key];
    }
    if(!integer(times.resultAppliedAt)||times.resultAppliedAt>=before)return null;
    events.push({id:row.id,eventType:type,sessionId:session,createdAt:row.createdAt,
      deliveryId:delivery,attemptId:payload.attemptId,attemptCount:payload.attemptCount,mode:payload.mode,
      result:kind,reason:payload.reason===null?null:reasons[kind].has(payload.reason)?payload.reason:'unknown',...times});
  }
  return {eventType:type,returnedCount:value.events.length,matchedCount:events.length,hasMore:false,events};
}
export async function run({requestSafe,logoutSafe,summary,safeSummary}){
  let browser,context,result=summary('controller'),projection=null,loggedOut=false;
  try{
    const token=process.env.SAM_PLAYWRIGHT_PRIMARY_USER;
    if(typeof token!=='string'||!token||token.startsWith('__SAM_SECRET_'))return summary('configuration');
    const {chromium}=await import('/tmp/reliability-browser-deps/node_modules/playwright/index.mjs');
    browser=await chromium.launch({headless:true});context=await browser.newContext();
    result=await requestSafe(context,api,{path:'/api/auth/token-login',method:'POST',data:{token}});
    delete process.env.SAM_PLAYWRIGHT_PRIMARY_USER;
    if(result.category!=='ok')throw new Error();
    const pages=[];
    for(const type of types){
      // The existing adapter rejects query strings. This fixed wrapper adds ONLY these reviewed selectors.
      const boundedContext={request:{fetch:async(url,options)=>{
        if(url!==api+'/api/projects/'+project+'/activity'||options.method!=='GET')throw new Error();
        const target=new URL(url);
        target.search=new URLSearchParams({sessionId:session,eventType:type,limit:'100',before:String(before)}).toString();
        return context.request.fetch(target.href,options);
      }}};
      let page;
      result=await requestSafe(boundedContext,api,{path:'/api/projects/'+project+'/activity'},value=>{
        page=projectHistoryPage(value,type);return page!==null;
      });
      if(result.category!=='ok')throw new Error();
      pages.push(page);
    }
    projection={sessionId:session,projectId:project,deliveryId:delivery,before,
      allPagesExhausted:true,retentionVerified:false,pages};
  }catch{projection=null;if(result.category==='ok')result=summary('controller');}
  finally{
    delete process.env.SAM_PLAYWRIGHT_PRIMARY_USER;
    if(context)try{
      const logout=await logoutSafe(context,api);
      const absent=await requestSafe(context,api,{path:'/api/auth/get-session'},value=>value===null);
      const protectedRead=await requestSafe(context,api,{path:'/api/nodes'});
      loggedOut=logout.category==='ok'&&absent.category==='ok'&&[401,403].includes(protectedRead.status);
    }catch{loggedOut=false;}
    if(browser)try{await browser.close();}catch{loggedOut=false;}
  }
  if(projection&&loggedOut)try{
    await writeFile(new URL('./attempt-history-result.json',import.meta.url),JSON.stringify(projection)+'\n',{flag:'wx',mode:0o600});
    return safeSummary(summary('ok',result.status,true));
  }catch{}
  return safeSummary(summary('controller'));
}
