# Bound self-host git imports before enabling them

H2 security review found that a compressed-response cap around isomorphic-git's in-memory clone does not bound inflated objects or delta allocations. A small public pack can exhaust the shared celld process before MemoryFS observes a write. Coordinator approved empty seeded repositories only for H2 on 2026-11-19 (message f52622cf-1aff-4052-9bde-67766706e15e); the generic import capability remains unregistered and importUrl is refused with 400.

- [ ] Design an importer enforcing object, cumulative decompression, delta depth, CPU/time and transport bounds before allocation (reuse hosted DO policy or isolated bounded execution).
- [ ] Preserve public-forge HTTPS allowlisting, redirect refusal, no embedded credentials and cleanup on refusal.
- [ ] Exercise compressed-bomb and stalled-source refusals, plus successful history/default-branch import through real project creation.
- [ ] Register the fallback import capability only when those tests and live self-host verification pass; document supported limits.
