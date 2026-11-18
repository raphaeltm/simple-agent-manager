import { $, state } from './state.js';

// A leaf module (only depends on state.js) so both api.js and plan.js can
// import it without creating a cycle between them.
export function invalidatePlan() {
  state.formRevision++;
  state.approvedPlan = undefined;
  $('review-form').hidden = true;
  $('review-blocked').hidden = true;
  $('plan-summary-line').textContent = '';
  $('plan-summary').replaceChildren();
}
