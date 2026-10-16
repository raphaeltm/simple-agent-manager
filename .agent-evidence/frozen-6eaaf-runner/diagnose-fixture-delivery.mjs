// Verification only: exact failed fixture; execute ONLY via safe-controller.mjs.
import { writeFile } from 'node:fs/promises';
const session='675e6493-dd46-49e3-85a5-54d6b58ef6be';
const project='01KJNR9R3TEN3KX1ETE33852R8';
const api='https://api.sammy.party';
const from=Date.parse('2026-10-15T21:27:00Z'),until=Date.parse('2026-10-15T21:29:00Z');
const states=new Set(['queued','delivering','retry_wait','delivered','acked','failed','ambiguous','expired']);
const receipts=new Set(['accepted','in_flight','completed','not_found','ambiguous']);
const reasons=new Set(['ttl_expired','max_attempts_exceeded','terminal_target','dead_target','wake_refused','unsupported_capability','delivery_conflict','lost_response','runtime_changed','receipt_unavailable']);
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const id=value=>typeof value==='string'&&(/^[0-9A-HJKMNP-TV-Z]{26}$/.test(value)||/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value));
export function projectDelivery(value) {
  if(!value||!Array.isArray(value.deliveries)||value.deliveries.length>50
    ||!integer(value.deliveryTotal)||value.deliveryTotal!==value.deliveries.length)return null;
  const flags={};
  for(const key of ['deliveryEnabled','legacyVmCompatEnabled','supervisorEnabled']){
    if(typeof value.featureConfig?.[key]!=='boolean')return null;
    flags[key]=value.featureConfig[key];
  }
  const ids=new Set();
  for(const row of value.deliveries){
    if(!row||row.targetSessionId!==session||!id(row.id)||ids.has(row.id)||!integer(row.createdAt))return null;
    ids.add(row.id);
  }
  const matches=value.deliveries.filter(row=>row.sourceKind==='user_followup'&&row.createdAt>=from&&row.createdAt<=until);
  if(matches.length!==1)return null;
  const row=matches[0];
  if(!states.has(row.deliveryState)||!integer(row.deliveryAttempts)
    ||!(row.receiptState===null||receipts.has(row.receiptState))
    ||!(row.lastError===null||typeof row.lastError==='string')
    ||!(row.terminalReason===null||typeof row.terminalReason==='string'))return null;
  const times={};
  for(const key of ['createdAt','nextAttemptAt','attemptStartedAt','lastDeliveryAt','expiresAt','acceptedAt','deliveredAt','receiptCheckedAt']){
    if(row[key]!==null&&!integer(row[key]))return null;
    times[key]=row[key];
  }
  return {sessionId:session,projectId:project,deliveryTotal:value.deliveryTotal,featureConfig:flags,
    delivery:{id:row.id,sourceKind:'user_followup',deliveryState:row.deliveryState,deliveryAttempts:row.deliveryAttempts,
      ...times,receiptState:row.receiptState,hasLastError:row.lastError!==null,
      hasTerminalReason:row.terminalReason!==null,
      terminalReason:row.terminalReason===null?null:reasons.has(row.terminalReason)?row.terminalReason:'unknown'}};
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
    // This normal endpoint enforces project task:read AND exact session creator ownership.
    result=await requestSafe(context,api,{path:'/api/projects/'+project+'/sessions/'+session+'/durability'},value=>{
      projection=projectDelivery(value);return projection!==null;
    });
    if(result.category!=='ok')throw new Error();
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
    await writeFile(new URL('./durability-result.json',import.meta.url),JSON.stringify(projection)+'\n',{flag:'wx',mode:0o600});
    return safeSummary(summary('ok',result.status,true));
  }catch{}
  return safeSummary(summary('controller'));
}
