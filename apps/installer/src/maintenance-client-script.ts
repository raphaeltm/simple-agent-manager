// Static, dependency-free script embedded only in owner-account maintenance
// pages (maintenance.ts's `page()`), never in the hosted installer's
// self-only-CSP pages (session.ts's `installerShell`, e.g. /handoff). It:
//  - copies the credential referenced by a button's `data-copy="<id>"` to the
//    clipboard, matching the hosted handoff page's Copy button behavior;
//  - disables a form's submit button until its required checkbox is ticked,
//    matching the hosted handoff page's "I saved it" gating;
//  - reloads the page on the server-provided `data-auto-refresh="<seconds>"`
//    interval, never while an open <details> contains a form ("Stop this
//    build", "Access & recovery"), a form control is focused, or any control
//    changed since load. Form-less disclosures such as "Show all stages" do not
//    pause it (that froze the page on 2026-11-07); their open state is kept in
//    sessionStorage across reloads instead. A bare HTTP
//    `Refresh` header cannot see any of that and used to collapse open
//    disclosures and clear the stop-build checkbox mid-action.
// `scripts/build-scene.mjs` extracts this exact backtick string to compute
// its CSP `script-src` hash, so keep it a single template literal.
export const maintenanceClientScript = `document.addEventListener("click",async function(event){var button=event.target.closest("[data-copy]");if(!button)return;var target=document.getElementById(button.getAttribute("data-copy"));if(!target)return;var value=target.textContent||"";var original=button.textContent;try{await navigator.clipboard.writeText(value);button.textContent="Copied"}catch(error){button.textContent="Copy failed — select the credential above"}setTimeout(function(){button.textContent=original},2000)});document.querySelectorAll("form").forEach(function(form){var checkbox=form.querySelector("input[type=checkbox][required]");var button=form.querySelector("button");if(!checkbox||!button)return;var sync=function(){button.disabled=!checkbox.checked};checkbox.addEventListener("change",sync);sync()});(function(){var root=document.querySelector("[data-auto-refresh]");if(!root)return;var seconds=parseInt(root.getAttribute("data-auto-refresh"),10);if(!(seconds>0))return;var key="sam-open-details";var plain=function(){return[].filter.call(document.querySelectorAll("details"),function(d){return!d.querySelector("form")})};try{var saved=JSON.parse(sessionStorage.getItem(key)||"[]");plain().forEach(function(d,i){if(saved.indexOf(i)>=0)d.open=true})}catch(error){}var dirty=false;document.addEventListener("change",function(){dirty=true});document.addEventListener("input",function(){dirty=true});setInterval(function(){if(dirty)return;if(document.querySelector("details[open] form"))return;var active=document.activeElement;if(active&&active!==document.body&&active.closest("form"))return;try{sessionStorage.setItem(key,JSON.stringify(plain().map(function(d,i){return d.open?i:-1}).filter(function(i){return i>=0})))}catch(error){}location.reload()},seconds*1000)})();`;
