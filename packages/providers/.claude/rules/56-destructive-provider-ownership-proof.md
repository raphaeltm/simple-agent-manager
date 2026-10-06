# Destructive Provider Ownership Proof

Provider discovery must never classify or delete an external resource from account
membership, a SAM-like name or prefix, environment alone, or absence from local D1.

For any destructive provider-side reconciliation:

- Require a stable, exact installation identity generated and persisted by the
  installation control plane.
- Require the expected environment/control-plane scope in addition to installation
  identity, and re-fetch/revalidate immutable resource identity plus both ownership
  scopes immediately before the provider delete boundary.
- Treat missing, duplicate, malformed, or foreign ownership metadata as ambiguous and
  preserve the resource.
- Validate inventory responses at the runtime boundary; failed, partial, malformed, or
  conflicting local state must fail closed before the provider delete call.
- Never destructively adopt legacy resources from names, prefixes, or credentials.
- Test two installations sharing one provider account and environment, including the
  same resource/name prefix, duplicate tag keys, legacy resources, corrupted inventory,
  and a same-run legitimate owned orphan positive control.
- Assert foreign and ambiguous resources never reach the provider delete boundary for
  every supported provider encoding.
