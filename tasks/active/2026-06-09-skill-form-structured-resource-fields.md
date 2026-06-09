# Replace Skill Form JSON Textarea with Structured Resource Fields

## Problem

The skill creation/edit dialog (`SkillFormDialog.tsx`) has a raw JSON textarea for `resourceRequirementsJson`. Users must know the exact JSON schema, type valid JSON by hand, and get no validation feedback until submit. This is bad UX.

The `ResourceRequirements` interface has only 5 well-defined fields — each should have its own form control with appropriate input types.

## Research Findings

### Key Files
- `apps/web/src/components/skills/SkillFormDialog.tsx` — the form dialog (lines 159-173 are the JSON textarea)
- `packages/shared/src/types/resource.ts` — `ResourceRequirements` interface (5 fields: minVcpu, minMemoryGb, minDiskGb, exclusiveNode, maxCoTenants)
- `apps/web/src/components/skills/SkillSelector.tsx:14-26` — `formatResourceSummary()` parses JSON for display; no changes needed
- `apps/web/src/components/skills/SkillList.tsx` — uses `formatResourceSummary`, no changes needed

### API Contract
- `resourceRequirementsJson` is stored and transmitted as a JSON string (`string | null`)
- The form must serialize structured fields → JSON on submit and deserialize JSON → fields on edit
- No backend changes needed

### Interaction Rules
- When `exclusiveNode` is checked, `maxCoTenants` should be disabled (exclusive = 1 co-tenant)
- All number fields are optional — empty = not set = inherit from defaults
- Existing helper text: "Optional. Minimum resource constraints for VM selection. Leave blank to use the VM size above."

## Implementation Checklist

- [ ] Replace `resourceRequirementsJson` state variable with individual state variables: `minVcpu`, `minMemoryGb`, `minDiskGb`, `exclusiveNode`, `maxCoTenants`
- [ ] Update `useEffect` to deserialize `skill.resourceRequirementsJson` into individual fields on edit
- [ ] Replace JSON textarea (lines 159-173) with structured fields:
  - 3 number inputs in `sm:grid-cols-3` grid: Min vCPUs, Min Memory (GB), Min Disk (GB)
  - 2 fields in a second row: Exclusive Node checkbox, Max Co-tenants number input
- [ ] Disable Max Co-tenants when Exclusive Node is checked
- [ ] Update `handleSubmit` to serialize individual fields → `resourceRequirementsJson` string
- [ ] Remove JSON parse validation from handleSubmit (no longer needed)
- [ ] Run Playwright visual audit at mobile (375px) and desktop (1280px)

## Acceptance Criteria

- [ ] No raw JSON textarea visible in the skill create/edit dialog
- [ ] Each resource requirement field has its own labeled form control
- [ ] Number inputs accept only numbers, with "Default" placeholder
- [ ] Exclusive Node is a checkbox
- [ ] Max Co-tenants disabled when Exclusive Node is checked
- [ ] Editing an existing skill with resource requirements populates the structured fields correctly
- [ ] Submitting the form produces the same `resourceRequirementsJson` format the API expects
- [ ] Empty fields result in those keys being omitted from the JSON (not set to null/0)
- [ ] Visual audit passes on mobile (375px) and desktop (1280px) with no overflow
