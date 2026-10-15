// Cleanup-only trusted entrypoint: one exact late workspace belonging to the already-authorized fixture.
// MUST execute through the reviewed safe-controller.mjs supervisor; no arbitrary command/target inputs.
export async function run({requestSafe,logoutSafe,summary,safeSummary}) {
  const api='https://api.sammy.party';
  const workspace='01M50QQG7ETJ01447C5KEBK0NV';
  const node='01M50P0SQGRH1E6BCB7RGP21XZ';
  const project='01KJNR9R3TEN3KX1ETE33852R8';
  const session='675e6493-dd46-49e3-85a5-54d6b58ef6be';
  let browser,context,result=summary('controller'),cleaned=false,loggedOut=false;
  try {
    const token=process.env.SAM_PLAYWRIGHT_PRIMARY_USER;
    if(typeof token!=='string'||!token||token.startsWith('__SAM_SECRET_'))return summary('configuration');
    const {chromium}=await import('/tmp/reliability-browser-deps/node_modules/playwright/index.mjs');
    browser=await chromium.launch({headless:true});context=await browser.newContext();
    result=await requestSafe(context,api,{path:'/api/auth/token-login',method:'POST',data:{token}});
    delete process.env.SAM_PLAYWRIGHT_PRIMARY_USER;
    if(result.category!=='ok')throw new Error();
    // The ordinary owner API must independently confirm the exact association BEFORE deletion.
    result=await requestSafe(context,api,{path:'/api/workspaces/'+workspace},value=>
      value?.id===workspace&&value.nodeId===node&&value.projectId===project&&value.chatSessionId===session);
    if(result.status===404){cleaned=true;result=summary('ok',404,true);}
    else {
      if(result.category!=='ok')throw new Error();
      result=await requestSafe(context,api,{path:'/api/workspaces/'+workspace,method:'DELETE'},value=>
        value?.success===true&&value.deletionStatus==='confirmed');
      if(result.category!=='ok')throw new Error();
      const absent=await requestSafe(context,api,{path:'/api/workspaces/'+workspace});
      if(absent.status!==404){result=summary('response',absent.status);throw new Error();}
      cleaned=true;
    }
  } catch { if(result.category==='ok')result=summary('controller'); }
  finally {
    delete process.env.SAM_PLAYWRIGHT_PRIMARY_USER;
    if(context){
      try {
        const logout=await logoutSafe(context,api);
        const absent=await requestSafe(context,api,{path:'/api/auth/get-session'},value=>value===null);
        const protectedRead=await requestSafe(context,api,{path:'/api/nodes'});
        loggedOut=logout.category==='ok'&&absent.category==='ok'&&[401,403].includes(protectedRead.status);
      }catch {loggedOut=false;}
    }
    if(browser){try {await browser.close();}catch {loggedOut=false;}}
  }
  return safeSummary(cleaned&&loggedOut?summary('ok',result.status,true):summary('controller'));
}
