# License Compatibility Analysis

**Date:** 2026-05-02

## SAM's License Context

SAM is considering AGPL for its license. This is important because:
- AGPL requires that modifications to the software be made available when the software is used to provide a network service
- This prevents competitors from taking SAM, modifying it, and offering it as a paid SaaS without contributing back
- SAM wants to remain open source and self-hostable

## License Compatibility Matrix

### Can AGPL SAM incorporate code under these licenses?

| License | Can Incorporate? | Resulting License | Notes |
|---------|-----------------|-------------------|-------|
| **MIT** | YES | AGPL (for the combined work) | MIT is compatible with AGPL. The MIT-licensed code retains its MIT license; the combined work is AGPL |
| **Apache 2.0** | YES (with AGPL v3) | AGPL v3 (for combined work) | Apache 2.0 is compatible with GPL v3 and AGPL v3. Not compatible with GPL v2 |
| **BSD 2/3-Clause** | YES | AGPL (for combined work) | BSD is permissive, compatible with AGPL |
| **ISC** | YES | AGPL (for combined work) | ISC is essentially MIT, fully compatible |
| **LGPL** | YES | AGPL (for combined work) | LGPL is compatible with AGPL |
| **GPL v3** | YES | AGPL v3 | GPL v3 and AGPL v3 are explicitly compatible |
| **GPL v2 only** | MAYBE | Complicated | GPL v2 and AGPL v3 may not be compatible. Avoid if possible |
| **SSPL** | NO | N/A | Server Side Public License is not OSI-approved and incompatible |
| **BSL** | NO | N/A | Business Source License is not open source |

### Candidate Licenses

| Project | License | Compatible with AGPL SAM? |
|---------|---------|--------------------------|
| Crush | TBD (likely MIT/Apache) | Almost certainly YES |
| Pi | MIT | YES |
| Plandex | MIT | YES |
| Mastra | Apache 2.0 | YES |
| Goose | Apache 2.0 | YES |
| Aider | Apache 2.0 | YES |
| OpenHands | MIT | YES |
| SWE-agent | MIT | YES |
| Claw Code | TBD | Need to verify |

## Practical Implications

### Incorporating MIT/Apache Code into AGPL SAM

When SAM incorporates MIT or Apache 2.0 licensed code:

1. **The original code retains its original license** — you cannot change MIT to AGPL
2. **The combined work is distributed under AGPL** — because AGPL is the most restrictive compatible license
3. **You must retain copyright notices and license files** from the original project
4. **You can modify the code freely** — both MIT and Apache 2.0 allow modification
5. **Attribution is required** — keep NOTICE files (Apache 2.0) and copyright headers

### What This Means for Integration

- **Fork approach:** Fork the repo, modify freely, include original LICENSE and NOTICE files. Ship as part of AGPL SAM.
- **Subtree approach:** Same as fork — the subtree'd code keeps its license, the combined work is AGPL.
- **Vendor approach:** Same rules — vendored code keeps its license.
- **Clean-room rewrite:** No license concerns at all — your code, your license.

### Key Risk: "License Contamination" Misconception

A common misconception is that AGPL "contaminates" the original project. It does not. If someone forks Crush (MIT) and incorporates it into SAM (AGPL), the original Crush repo remains MIT. Only SAM's combined distribution is AGPL.

## Recommendation

All top candidates (Crush, Pi, Plandex, Mastra) use MIT or Apache 2.0 licenses, both of which are compatible with AGPL. There are **no license blockers** for any of the recommended integration approaches.

The safest approach is still the **clean-room rewrite** (zero license concerns), but the fork/subtree approach is legally sound for all candidates.
