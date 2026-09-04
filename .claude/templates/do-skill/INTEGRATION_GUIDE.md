# Integration Guide: Adding Portable /do Skill to Your Project

This guide explains how to integrate the portable `/do` skill into your agent environment.

## Prerequisites

- Git repository with a main/master branch
- Claude Code or similar AI agent system
- Basic command-line tools (git, your language's package manager)

## Integration Options

### Option 1: Full Template System (Recommended)

Use the template and configuration system for maximum flexibility.

**Steps:**

1. **Copy the template directory to your project:**
   ```bash
   cp -r /path/to/sam/.claude/templates/do-skill .claude/templates/do-skill
   ```

2. **Create your project's configuration:**
   ```bash
   cd .claude/templates/do-skill
   cp examples/agent-box-config.json my-project-config.json
   ```

3. **Customize the configuration:**
   Edit `my-project-config.json` to match your project's:
   - Directory structure
   - Quality commands
   - Available reviewers
   - Deployment workflows
   - Conventions

4. **Generate your /do skill:**
   ```bash
   npm install
   node generate-skill.js my-project-config.json ../../commands/do.md
   ```

5. **Test the workflow:**
   - Try the `/do` command with a simple task
   - Verify each phase works as expected
   - Adjust configuration as needed

### Option 2: Direct Customization

Copy and manually customize the template.

**Steps:**

1. **Copy the template:**
   ```bash
   mkdir -p .claude/commands
   cp /path/to/sam/.claude/templates/do-skill/do-template.md .claude/commands/do.md
   ```

2. **Manual replacements:**
   - Replace `{{project.taskPaths.backlog}}` with your actual path
   - Replace `{{workflow.trackingTool}}` sections with your tracking approach
   - Replace quality commands with your tools
   - Remove or adjust staging verification based on your needs

3. **Remove unused sections:**
   - Delete conditional blocks you don't need
   - Simplify reviewer lists
   - Adjust phases to match your workflow

### Option 3: Hybrid Approach

Use parts of the workflow without the full system.

**Steps:**

1. **Review the template** to identify useful patterns
2. **Extract phases** that apply to your workflow
3. **Integrate** into your existing agent commands
4. **Adapt** the quality gates and review system

## Configuration Checklist

When creating your configuration, ensure you've set:

### Essential

- [ ] `project.taskPaths` - Where task files are stored
- [ ] `workflow.trackingTool` - How workflow state is tracked
- [ ] `workflow.gitWorkflow.mainBranch` - Your default branch name
- [ ] `phases.implementation.qualityCommands` - Your lint/test/build commands

### Quality Gates

- [ ] `phases.review.reviewers` - Available code reviewers
- [ ] `phases.implementation.buildOrder` - Package dependencies (if applicable)

### Optional but Recommended

- [ ] `project.rulesPath` - Where project rules/guidelines live
- [ ] `phases.staging` - Staging environment configuration
- [ ] `phases.pr.template` - PR template path
- [ ] `conventions` - Project conventions and principles

## Adapting to Different Tech Stacks

### Python Projects

```json
{
  "phases": {
    "implementation": {
      "qualityCommands": {
        "typecheck": "mypy .",
        "lint": "ruff check . && black --check .",
        "test": "pytest --cov",
        "build": "poetry build"
      }
    }
  }
}
```

### Go Projects

```json
{
  "phases": {
    "implementation": {
      "qualityCommands": {
        "typecheck": "go vet ./...",
        "lint": "golangci-lint run",
        "test": "go test ./...",
        "build": "go build ./..."
      }
    }
  }
}
```

### Rust Projects

```json
{
  "phases": {
    "implementation": {
      "qualityCommands": {
        "typecheck": "cargo check",
        "lint": "cargo clippy -- -D warnings",
        "test": "cargo test",
        "build": "cargo build --release"
      }
    }
  }
}
```

### Monorepo Projects

```json
{
  "phases": {
    "implementation": {
      "buildOrder": ["packages/core", "packages/utils", "apps/api", "apps/web"],
      "qualityCommands": {
        "typecheck": "pnpm -r typecheck",
        "lint": "pnpm -r lint",
        "test": "pnpm -r test",
        "build": "pnpm -r build"
      }
    }
  }
}
```

## Customizing Reviewers

### Using Skills

If your agent environment supports skills (like SAM):

```json
{
  "reviewers": [
    {
      "name": "code-review",
      "skill": "/code-review",
      "trigger": { "always": true },
      "checks": "Code quality and correctness"
    }
  ]
}
```

### Using Subagents

If your environment can spawn subagents:

```json
{
  "reviewers": [
    {
      "name": "security-auditor",
      "agent": "security-specialist",
      "trigger": { "paths": ["**/*auth*"] },
      "checks": "Security vulnerabilities"
    }
  ]
}
```

### Using External Tools

If you rely on external review tools:

```json
{
  "reviewers": [
    {
      "name": "sonarqube",
      "command": "sonar-scanner",
      "trigger": { "always": true },
      "checks": "Static analysis via SonarQube"
    }
  ]
}
```

## Workflow Tracking Options

### TodoWrite (SAM-specific)

SAM's built-in todo tracking:

```json
{
  "workflow": {
    "trackingTool": "TodoWrite"
  }
}
```

### TaskCreate (MCP-based)

For systems with MCP task management:

```json
{
  "workflow": {
    "trackingTool": "TaskCreate"
  }
}
```

### Markdown Checklist

Simple markdown-based tracking:

```json
{
  "workflow": {
    "trackingTool": "markdown"
  }
}
```

The template will generate phase tracking in the state file.

### No Tracking

If you prefer manual tracking:

```json
{
  "workflow": {
    "trackingTool": "none"
  }
}
```

## Staging Verification Options

### Full Staging Environment

If you have a complete staging environment:

```json
{
  "phases": {
    "staging": {
      "enabled": true,
      "required": true,
      "deployment": {
        "workflow": "deploy-staging.yml",
        "checkCommand": "gh run list --workflow=deploy-staging.yml --status=in_progress",
        "triggerCommand": "gh workflow run deploy-staging.yml --ref $BRANCH",
        "watchCommand": "gh run watch $RUN_ID"
      },
      "environment": {
        "appUrl": "https://staging.example.com",
        "authMethod": "token"
      }
    }
  }
}
```

### Optional Staging

If staging verification is recommended but not blocking:

```json
{
  "phases": {
    "staging": {
      "enabled": true,
      "required": false
    }
  }
}
```

### No Staging

For projects without a staging environment:

```json
{
  "phases": {
    "staging": {
      "enabled": false
    }
  }
}
```

## Testing Your Integration

After integrating, test with a simple task:

1. **Create a test task:**
   ```
   /do Add a comment to the README explaining the project name
   ```

2. **Monitor phase execution:**
   - Phase 1: Should create a task file
   - Phase 2: Should set up worktree
   - Phase 3: Should make the change
   - Phase 4: Should run quality checks
   - Phase 5: Should run reviewers (if enabled)
   - Phase 6: Should verify on staging (if enabled)
   - Phase 7: Should create and merge PR

3. **Verify outputs:**
   - Task file created and moved through statuses
   - Worktree created and cleaned up
   - PR created with proper template
   - All quality gates passed

## Troubleshooting

### "Tracking tool not found"

**Problem:** The workflow tracking tool isn't available in your environment.

**Solution:** 
- Change `workflow.trackingTool` to "markdown" or "none"
- Implement manual tracking in the state file

### "Quality command failed"

**Problem:** Quality commands from config don't work in your project.

**Solution:**
- Update `phases.implementation.qualityCommands` to match your tools
- Ensure commands work from project root
- Check that dependencies are installed

### "Reviewer skill not found"

**Problem:** Reviewers in config reference skills that don't exist.

**Solution:**
- Remove reviewers that don't apply
- Change `skill` to `command` for external tools
- Set `phases.review.enabled` to false to disable reviews

### "Staging deployment failed"

**Problem:** Staging configuration doesn't match your infrastructure.

**Solution:**
- Disable staging: `phases.staging.enabled = false`
- Update deployment commands to match your CI/CD
- Adjust environment URLs

## Migration from SAM

If you're moving from SAM to another environment:

1. **Start with SAM's config:**
   ```bash
   cp examples/sam-config.json my-config.json
   ```

2. **Remove SAM-specific parts:**
   - Replace TodoWrite with markdown tracking
   - Remove SAM MCP reviewers
   - Remove staging if not applicable
   - Adjust paths to your structure

3. **Add your environment's tools:**
   - Update quality commands
   - Add your reviewers
   - Configure your deployment

4. **Test incrementally:**
   - Start with minimal config
   - Add features one at a time
   - Verify each addition works

## Best Practices

### Start Simple

- Begin with minimal configuration
- Enable only essential phases
- Add complexity as needed

### Document Customizations

- Add comments in your config
- Note why you deviated from defaults
- Keep a changelog of config changes

### Version Control

- Check config into git
- Track template version used
- Document local modifications

### Team Alignment

- Share config with team
- Document workflow expectations
- Train team on `/do` usage

## Next Steps

After successful integration:

1. **Create project-specific rules** in your rules directory
2. **Develop custom reviewers** for your tech stack
3. **Refine quality gates** based on your needs
4. **Train team members** on the workflow
5. **Iterate and improve** based on usage

## Support and Updates

- **Template updates**: Pull latest from SAM's repository
- **Configuration help**: See `do-config.schema.json`
- **Examples**: Check `examples/` directory
- **Issues**: Contribute back to the template project
