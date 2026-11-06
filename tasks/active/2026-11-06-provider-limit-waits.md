# Provider-limit waits and owner recovery

## Problem
Known resets must resume automatically. Rejections in one window currently burn the unknown-reset budget; event deliveries bypass the scheduled-action check and can create a feedback loop. Blocked waits have no owner action and disagree with snapshot/chat recovery state.

## Research
- provider-limit-policy.ts increments attempts for every new prompt incident, even identical reset timestamps.
- project-event-schedules-delivery.ts checks scheduled_action only, not subscription deliveries.
- provider-limit-admission.ts stops the runner alarm for blocked waits.
- Production read-only story confirms queued/provider_limit_blocked + waking snapshot + sleeping/wake_failed chat. Do not mutate production task 01M6RQCRCN3F8ERRCREDPVQEKJ.
- Existing provider-limit-lifecycle and provider-limit-admission integration fixtures drive callback, durable alarms, and TaskRunner.

## Checklist / acceptance
- [ ] Deduplicate same credential/window waits, preserve known reset retry and unknown reset budget.
- [ ] Trace and guard real subscription prompt delivery; defer while waiting, suppress own credential events.
- [ ] Owner resume API and dashboard/chat controls wake retained snapshot.
- [ ] Coherent blocked task/chat/snapshot state.
- [ ] Parent cancellation if small; otherwise update related idea.
- [ ] Real entry point regression tests and guard reversion red/green evidence.
- [ ] UI mobile/desktop screenshot audit; lint/typecheck/test/build.
- [ ] Specialist review, staging, PR/CI/CodeRabbit, merge/deploy.
- [ ] Update idea 01M6SKEAYHG5P9T8ES3Z331A37 with PR/outcome.

## References
Ideas 01M6SKEAYHG5P9T8ES3Z331A37, 01M6GW3B0YQJVBE6Q8Q1SCX1W3; rules 35/62; /do.
