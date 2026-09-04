# Portable /do Skill - Changelog

## [1.0.0] - 2026-08-27

### Added

- **Core Template System**
  - `do-template.md`: Handlebars-based template with configurable variables
  - `do-config.schema.json`: JSON schema for configuration validation
  - Conditional logic for optional phases
  - Variable substitution for all customization points

- **Example Configurations**
  - `examples/sam-config.json`: Full-featured SAM configuration
  - `examples/agent-box-config.json`: Minimal NixOS environment configuration

- **Generator Scripts**
  - `generate-skill.js`: Node.js/Handlebars template processor
  - `generate-skill.py`: Python/pybars template processor
  - `package.json`: NPM scripts and dependencies

- **Documentation**
  - `README.md`: Comprehensive usage guide
  - `INTEGRATION_GUIDE.md`: Step-by-step integration instructions
  - Schema documentation in JSON schema format

### Features

- **Configurable Workflow Tracking**: Support for TodoWrite, TaskCreate, markdown, or no tracking
- **Flexible Review System**: Skills, subagents, or external tools
- **Optional Staging Verification**: Enable/disable based on environment
- **Customizable Quality Commands**: Language-agnostic quality gates
- **Modular Phases**: Enable/disable phases independently
- **Git Workflow Configuration**: Customizable branching and commit strategies
- **Build Order Support**: For monorepo and multi-package projects
- **Infrastructure Verification**: Optional infrastructure-specific checks

### Design Principles

- **Portability**: Works with any agent environment
- **Configurability**: Extensive customization without template changes
- **Maintainability**: Separation of logic (template) and config
- **Extensibility**: Clear extension points for custom phases
- **Documentation**: Comprehensive guides and examples

### Supported Environments

- **SAM** (full-featured): TodoWrite, MCP reviewers, staging, deploy monitoring
- **agent-box** (minimal): Markdown tracking, basic reviews, no staging
- **Generic**: Adaptable to any Claude-based agent environment

### Breaking Changes from SAM's Built-in /do

- None - SAM can generate identical output using `examples/sam-config.json`
- Template variables replace hardcoded values
- Configuration file required for generation

### Migration Path

- SAM users: Use provided config to generate equivalent skill
- New projects: Start with minimal config and expand
- Existing workflows: Adapt template to match current process
