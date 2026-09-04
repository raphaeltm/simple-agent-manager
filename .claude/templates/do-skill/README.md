# Portable /do Skill Template

This directory contains a portable, configuration-driven version of the `/do` skill workflow that can be adapted to any agent environment.

## Overview

The `/do` skill provides an autonomous, multi-phase workflow for taking a task from initial request to merged pull request with minimal human intervention. The workflow includes:

1. **Research & Task Creation** - Understanding the request and documenting the plan
2. **Worktree Setup** - Creating an isolated workspace for the changes
3. **Implementation** - Executing the planned changes with quality checks
4. **Pre-PR Validation** - Running comprehensive quality suite
5. **Review** - Specialist validation appropriate to the changes
6. **Staging Verification** - Testing in a production-like environment (optional)
7. **PR & Merge** - Creating PR, monitoring CI, merging, and tracking deployment

## Quick Start

### For New Projects

1. **Copy the template**: Copy `do-template.md` to your project's command/skill directory (e.g., `.claude/commands/do.md`)

2. **Create a configuration**: Create a `do-config.json` based on one of the examples:
   - See `examples/sam-config.json` for a full-featured configuration
   - See `examples/agent-box-config.json` for a minimal configuration

3. **Process the template**: Replace template variables with your configuration values. You can:
   - Use a Handlebars processor
   - Manually replace `{{variable}}` placeholders
   - Use a custom script to generate the final skill file

4. **Customize as needed**: The template is a starting point. Add project-specific logic where indicated.

### For Existing Projects

If your project already has a workflow system, you can:

1. Review the template structure for ideas
2. Adapt individual phases rather than adopting the whole workflow
3. Use the configuration schema to document your workflow's extension points

## Configuration

The configuration file (`do-config.json`) controls all aspects of the workflow. See `do-config.schema.json` for the full schema.

### Key Configuration Sections

#### Project Structure
```json
{
  "project": {
    "taskPaths": {
      "backlog": "tasks/backlog",
      "active": "tasks/active", 
      "archive": "tasks/archive"
    },
    "rulesPath": ".claude/rules",
    "docsPath": "docs",
    "specsPath": "specs"
  }
}
```

#### Workflow Tracking
```json
{
  "workflow": {
    "trackingTool": "TodoWrite",  // or "TaskCreate", "markdown", "none"
    "stateFile": ".do-state.md",
    "gitWorkflow": {
      "worktreePrefix": "../work",
      "branchPrefix": "feat/",
      "mainBranch": "main",
      "taskCommitToMain": false
    }
  }
}
```

#### Quality Commands
```json
{
  "phases": {
    "implementation": {
      "buildOrder": ["shared", "api", "web"],
      "qualityCommands": {
        "typecheck": "npm run typecheck",
        "lint": "npm run lint",
        "test": "npm test",
        "build": "npm run build"
      }
    }
  }
}
```

#### Review System
```json
{
  "phases": {
    "review": {
      "enabled": true,
      "reviewers": [
        {
          "name": "code-review",
          "skill": "/code-review",  // or use "agent" for spawning subagents
          "trigger": { "always": true },
          "checks": "Code quality and best practices"
        },
        {
          "name": "security-check",
          "skill": "/security-review",
          "trigger": { "paths": ["**/*auth*", "**/*credential*"] },
          "checks": "Security vulnerabilities"
        }
      ]
    }
  }
}
```

#### Staging Verification
```json
{
  "phases": {
    "staging": {
      "enabled": true,
      "required": true,
      "deployment": {
        "workflow": "deploy-staging.yml",
        "checkCommand": "gh run list --workflow=deploy-staging.yml ...",
        "triggerCommand": "gh workflow run deploy-staging.yml --ref $BRANCH",
        "watchCommand": "gh run watch $RUN_ID"
      },
      "environment": {
        "appUrl": "https://staging.example.com",
        "apiUrl": "https://api-staging.example.com",
        "authMethod": "token"
      }
    }
  }
}
```

## Template Variables

The template uses Handlebars-style syntax for variables:

- `{{variable}}` - Simple variable substitution
- `{{#if condition}}...{{/if}}` - Conditional blocks
- `{{#each array}}...{{/each}}` - Iteration

### Common Variables

- `{{project.taskPaths.backlog}}` - Path to task backlog
- `{{workflow.stateFile}}` - State persistence file
- `{{workflow.gitWorkflow.mainBranch}}` - Main git branch name
- `{{phases.implementation.qualityCommands.lint}}` - Lint command
- `{{phases.staging.enabled}}` - Whether staging verification is enabled

See the template for all available variables.

## Examples

### SAM (Simple Agent Manager)

SAM uses the full workflow with:
- TodoWrite for tracking
- Specialist subagent reviewers
- Mandatory staging verification
- Infrastructure verification for VM changes
- Post-merge deploy monitoring

See `examples/sam-config.json` for the complete configuration.

### agent-box

agent-box uses a simplified workflow with:
- Markdown-based tracking
- Basic code review via skills
- No staging environment
- NixOS build system

See `examples/agent-box-config.json` for the complete configuration.

## Customization Points

### Adding Custom Phases

You can add project-specific phases by:

1. Adding configuration in `phases.<custom-phase>`
2. Adding a new phase section in the template
3. Updating the phase tracking in Phase 0

### Custom Quality Checks

Replace or extend quality commands:

```json
{
  "qualityCommands": {
    "typecheck": "mypy .",
    "lint": "ruff check . && black --check .",
    "test": "pytest --cov",
    "build": "poetry build",
    "custom": "my-custom-check"
  }
}
```

### Custom Reviewers

Add reviewers based on your project's tools:

```json
{
  "reviewers": [
    {
      "name": "performance-review",
      "skill": "/performance-check",
      "trigger": { "paths": ["src/**/*.py"] },
      "checks": "Performance regressions"
    }
  ]
}
```

### Disabling Phases

Set `enabled: false` to skip optional phases:

```json
{
  "phases": {
    "staging": { "enabled": false },
    "review": { "enabled": false }
  }
}
```

## Processing the Template

### Using Handlebars (JavaScript/Node.js)

```javascript
const Handlebars = require('handlebars');
const fs = require('fs');

const template = fs.readFileSync('do-template.md', 'utf8');
const config = JSON.parse(fs.readFileSync('my-config.json', 'utf8'));

const compiled = Handlebars.compile(template);
const output = compiled(config);

fs.writeFileSync('.claude/commands/do.md', output);
```

### Using Python

```python
import json
from pybars import Compiler

compiler = Compiler()

with open('do-template.md') as f:
    template = compiler.compile(f.read())

with open('my-config.json') as f:
    config = json.load(f)

output = template(config)

with open('.claude/commands/do.md', 'w') as f:
    f.write(output)
```

### Manual Processing

For simple configurations, you can manually replace variables:

1. Copy `do-template.md` to your commands directory
2. Find and replace `{{variable}}` with actual values
3. Remove conditional blocks (`{{#if}}...{{/if}}`) as appropriate
4. Remove iteration blocks if not needed

## Migration Guide

### From SAM's /do skill

If you're migrating from SAM's built-in `/do` skill:

1. Your existing workflow should continue to work
2. To use the configurable version:
   - Use `examples/sam-config.json` as your config
   - Process the template with this config
   - The output should match your current skill

### To a New Project

1. Start with the minimal config from `examples/agent-box-config.json`
2. Adjust paths to match your project structure
3. Configure quality commands for your tech stack
4. Add reviewers based on your available tools
5. Enable/disable phases based on your needs

## Best Practices

### Configuration

- **Version control your config**: Check `do-config.json` into git
- **Document customizations**: Add comments explaining project-specific logic
- **Keep it simple**: Start with minimal config and add features as needed

### Template Customization

- **Preserve phase structure**: The 7-phase structure is battle-tested
- **Add don't subtract**: Add project-specific checks rather than removing standard ones
- **Document changes**: Note why you deviated from the template

### Workflow Usage

- **Trust the process**: Follow all phases; shortcuts create bugs
- **Track state**: Use the state file to survive context compaction
- **Review thoroughly**: Don't skip the review phase
- **Verify end-to-end**: Staging/testing prevents production issues

## Troubleshooting

### Template Processing Errors

- **Syntax errors**: Ensure JSON config is valid
- **Missing variables**: All referenced variables must exist in config
- **Conditional logic**: Check `{{#if}}` conditions evaluate correctly

### Runtime Issues

- **Tracking tool not found**: Ensure `workflow.trackingTool` is available in your environment
- **Quality commands fail**: Verify commands in `qualityCommands` work in your project
- **Reviewer not found**: Ensure skills/agents in `reviewers` are defined

## Contributing

To improve the template:

1. Test changes with multiple configuration types
2. Update schema when adding new config options
3. Add examples for new features
4. Update this README with new capabilities

## Support

For questions about:
- **The template system**: See this README and the schema
- **SAM's implementation**: See SAM's documentation
- **Your project's workflow**: Consult your project's documentation
