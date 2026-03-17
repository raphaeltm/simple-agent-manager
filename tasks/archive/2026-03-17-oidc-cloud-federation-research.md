# OIDC Cloud Federation Research for Defang Deployment

## Problem Statement

SAM workspaces need the ability to deploy applications to cloud providers (AWS, GCP, Azure) using Defang, authenticated via short-lived JWTs tied to the workspace/project — eliminating the need for users to manage long-lived cloud credentials inside workspaces.

## Research Scope

- How OIDC federation works with AWS, GCP, and Azure
- SAM acting as a custom OIDC identity provider
- Defang's authentication model and how it could consume SAM-issued tokens
- Best practices for signing keys, JWKS endpoints, and token claims
- Security considerations and implementation approach

## Implementation Checklist

- [x] Research AWS OIDC federation (inbound)
- [x] Research GCP Workload Identity Federation
- [x] Research Azure Workload Identity Federation
- [x] Research Defang architecture and authentication model
- [x] Research SPIFFE/SPIRE and workload identity patterns
- [x] Audit SAM's existing JWT infrastructure
- [x] Research best practices for custom OIDC providers
- [ ] Write research document in `docs/research/`

## Acceptance Criteria

- [ ] Research document covers all three major cloud providers (AWS, GCP, Azure)
- [ ] Document explains how SAM would act as a custom OIDC identity provider
- [ ] Document covers Defang integration path
- [ ] Document includes security best practices and recommendations
- [ ] Document identifies what SAM already has vs. what needs to be built

## References

- `apps/api/src/services/jwt.ts` — SAM's existing RS256 JWT signing
- `apps/api/src/index.ts` — Env interface with JWT_PRIVATE_KEY, JWT_PUBLIC_KEY
- AWS OIDC Federation docs
- GCP Workload Identity Federation docs
- Azure Workload Identity Federation docs
- Defang docs (defang.io)
- Latacora OIDC bridge implementation
