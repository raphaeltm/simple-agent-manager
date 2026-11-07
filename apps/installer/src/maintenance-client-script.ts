// Static, dependency-free script embedded only in owner-account maintenance
// pages (maintenance.ts's `page()`), never in the hosted installer's
// self-only-CSP pages (session.ts's `installerShell`, e.g. /handoff). It:
//  - copies the credential referenced by a button's `data-copy="<id>"` to the
//    clipboard, matching the hosted handoff page's Copy button behavior;
//  - disables a form's submit button until its required checkbox is ticked,
//    matching the hosted handoff page's "I saved it" gating.
// `scripts/build-scene.mjs` extracts this exact backtick string to compute
// its CSP `script-src` hash, so keep it a single template literal.
export const maintenanceClientScript = `document.addEventListener("click",async function(event){var button=event.target.closest("[data-copy]");if(!button)return;var target=document.getElementById(button.getAttribute("data-copy"));if(!target)return;var value=target.textContent||"";var original=button.textContent;try{await navigator.clipboard.writeText(value);button.textContent="Copied"}catch(error){button.textContent="Copy failed — select the credential above"}setTimeout(function(){button.textContent=original},2000)});document.querySelectorAll("form").forEach(function(form){var checkbox=form.querySelector("input[type=checkbox][required]");var button=form.querySelector("button");if(!checkbox||!button)return;var sync=function(){button.disabled=!checkbox.checked};checkbox.addEventListener("change",sync);sync()});`;
