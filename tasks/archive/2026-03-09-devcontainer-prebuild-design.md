# Devcontainer Prebuild Acceleration — Design Document

**Created**: 2026-03-09
**Type**: Design document

## Problem

Devcontainer builds during workspace creation take 5-15 minutes. Pre-building images when `.devcontainer/` changes and pulling them at workspace creation time could reduce this to 30-60 seconds.

## Deliverable

Design document at `docs/design/devcontainer-prebuild-acceleration.md` covering:
- Pre-build trigger mechanism (GitHub App webhooks)
- Build system (GitHub Actions + devcontainers/ci)
- Registry selection (ghcr.io primary, Cloudflare serverless registry future)
- VM agent integration (graceful fallback)
- Phased implementation plan

## Checklist

- [x] Research current devcontainer instantiation flow
- [x] Research Cloudflare container registry options
- [x] Research devcontainer pre-build best practices
- [x] Write design document
- [x] Open PR for review

## Acceptance Criteria

- [ ] Design document covers trigger, build, registry, and agent integration
- [ ] Architecture diagram shows the full flow
- [ ] Implementation is phased with clear scope per phase
- [ ] Risks and mitigations documented
- [ ] Open questions identified for discussion
