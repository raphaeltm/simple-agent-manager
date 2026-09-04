# Make /do Skill Portable for Other Agent Environments

## Problem Statement

The `/do` skill in SAM is highly effective but tightly coupled to SAM-specific infrastructure:
- SAM MCP tools (task-completion-validator, specialist reviewers)
- TodoWrite for workflow tracking
- SAM staging environment (app.sammy.party)
- SAM project structure (tasks/, .claude/rules/, etc.)
- GitHub Actions workflows specific to SAM

This prevents other agent environments (like agent-box, a NixOS-based agent sandbox) from reusing this proven workflow pattern.

## Goal

Create a portable, configuration-driven version of the `/do` skill that can be adapted to any agent environment while preserving the core workflow structure.

## Research Findings

### Current /do Skill Structure
- **7 phases**: Research, Worktree Setup, Implementation, Pre-PR Validation, Review, Staging Verification, PR/Merge
- **Length**: 323 lines
- **Key pattern**: Autonomous execution with quality gates at each phase

### SAM-Specific Dependencies
1. **Workflow Tracking**: TodoWrite tool
2. **Review System**: Local subagent reviewers (task-completion-validator, go-specialist, etc.)
3. **Infrastructure**: Staging deployment workflows, specific URLs
4. **Project Structure**: tasks/backlog/, tasks/active/, .claude/rules/
5. **State Persistence**: .do-state.md format

### Target Environments
- **agent-box**: NixOS-based multi-user Claude/Codex sandboxes
- **Generic**: Any Claude-based agent environment

## Implementation Checklist

### Phase 1: Create Core Framework
- [x] Extract workflow phases into a template structure
- [x] Identify all configuration points (paths, tools, URLs)
- [x] Create a configuration schema/format
- [x] Design extension points for project-specific customizations

### Phase 2: Build Generic Template
- [x] Create `.claude/templates/do-skill/` directory
- [x] Build `do-template.md` with placeholder variables
- [x] Create `do-config.schema.json` for configuration
- [x] Write `README.md` explaining customization

### Phase 3: Create Configuration System
- [x] Design config file format (JSON)
- [x] Define configuration categories (paths, tools, workflows, reviewers)
- [x] Create SAM's config as an example
- [x] Create agent-box config as an example

### Phase 4: Documentation
- [x] Write adaptation guide (INTEGRATION_GUIDE.md)
- [x] Document each configuration point (schema + README)
- [x] Provide migration path for existing projects
- [x] Create quick-start for new projects

### Phase 5: Tooling & Support
- [x] Create generator scripts (Node.js and Python)
- [x] Add package.json with NPM scripts
- [x] Create changelog
- [x] Make scripts executable

## Deliverables

### Core Files
- `.claude/templates/do-skill/do-template.md` - Handlebars template with variables
- `.claude/templates/do-skill/do-config.schema.json` - JSON schema for validation
- `.claude/templates/do-skill/README.md` - Usage documentation
- `.claude/templates/do-skill/INTEGRATION_GUIDE.md` - Step-by-step integration
- `.claude/templates/do-skill/CHANGELOG.md` - Version history

### Example Configurations
- `.claude/templates/do-skill/examples/sam-config.json` - SAM's full config
- `.claude/templates/do-skill/examples/agent-box-config.json` - Minimal NixOS config

### Generator Tools
- `.claude/templates/do-skill/generate-skill.js` - Node.js generator
- `.claude/templates/do-skill/generate-skill.py` - Python generator
- `.claude/templates/do-skill/package.json` - NPM dependencies

## Acceptance Criteria

- [x] Generic `/do` template exists with clear extension points
- [x] Configuration system supports different:
  - Workflow tracking tools (TodoWrite, TaskCreate, markdown, none)
  - Review systems (skills, subagents, external tools)
  - Deployment infrastructure (GitHub Actions, custom scripts, none)
  - Project structures (paths fully configurable)
- [x] SAM's `/do` skill can be generated from template + config
- [x] Documentation shows how to adapt for new environments
- [x] At least one non-SAM example configuration exists (agent-box)
- [x] Generator scripts provided (Node.js and Python)

## Key Design Decisions

### Template Engine: Handlebars
- Industry-standard, widely supported
- Clean syntax for conditionals and iteration
- Available in both JavaScript and Python

### Configuration Format: JSON
- Schema validation support
- Language-agnostic
- Human-readable and editable

### Extension Points
- All paths configurable
- All commands configurable
- Phases can be enabled/disabled
- Reviewers fully customizable
- Staging optional

### Backward Compatibility
- SAM can generate identical output from config
- No breaking changes to SAM's workflow
- Migration path documented

## References

- Current implementation: `.claude/commands/do.md`
- Target environment: https://github.com/defangdevs/agent-box
- Related rules: `.claude/rules/14-do-workflow-persistence.md`
