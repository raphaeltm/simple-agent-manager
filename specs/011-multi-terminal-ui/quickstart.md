# Multi-Terminal UI Quickstart

## Overview
The multi-terminal feature allows you to run multiple independent terminal sessions within a single browser tab, similar to tabs in modern terminal applications.

## Quick Start

### Opening Multiple Terminals

1. **Open a workspace** - Navigate to your workspace from the dashboard
2. **Create new terminal** - Click the **+** button in the tab bar or press `Ctrl+Shift+T`
3. **Switch between terminals** - Click on tabs or use `Ctrl+Tab` / `Ctrl+Shift+Tab`
4. **Close a terminal** - Click the **×** on a tab or press `Ctrl+Shift+W`

### Keyboard Shortcuts

| Action | Shortcut | Description |
|--------|----------|-------------|
| New Terminal | `Ctrl+Shift+T` | Create a new terminal tab |
| Close Terminal | `Ctrl+Shift+W` | Close the current terminal |
| Next Tab | `Ctrl+Tab` | Switch to the next terminal |
| Previous Tab | `Ctrl+Shift+Tab` | Switch to the previous terminal |
| Jump to Tab | `Alt+[1-9]` | Jump directly to tab by number |

### Tab Management

- **Rename tabs** - Double-click on a tab name to edit it
- **Reorder tabs** - Drag and drop tabs to rearrange
- **Tab overflow** - When many tabs are open, use the scroll arrows or dropdown menu
- **Active indicator** - The current terminal has a highlighted tab

## Features

### Independent Sessions
Each terminal maintains its own:
- Working directory
- Command history
- Environment variables
- Running processes
- Scroll buffer

### Persistent Connections
- Terminals continue running when you switch tabs
- Background processes keep executing
- Output is captured even for inactive terminals

### Resource Management
- Maximum of 10 concurrent terminals (configurable)
- Idle terminals auto-close after 1 hour
- Memory optimized for inactive tabs

## Mobile Support

On mobile devices:
- **Swipe** left/right on the tab bar to scroll through terminals
- **Tap** the **⋮** menu for a dropdown list of all terminals
- **Long press** on a tab to access rename/close options

## Configuration

Environment variables for customization:
```bash
# Maximum concurrent terminals (default: 10)
VITE_MAX_TERMINAL_SESSIONS=10

# Scrollback buffer size per terminal (default: 1000)
VITE_TERMINAL_SCROLLBACK_LINES=1000

# Tab switch animation duration in ms (default: 200)
VITE_TAB_SWITCH_ANIMATION_MS=200
```

## Common Use Cases

### Development Workflow
1. **Terminal 1**: Run your development server (`npm run dev`)
2. **Terminal 2**: Run tests in watch mode (`npm test -- --watch`)
3. **Terminal 3**: Git operations and file management
4. **Terminal 4**: Database console or logs monitoring

### DevOps Tasks
1. **Terminal 1**: SSH to production server
2. **Terminal 2**: SSH to staging server
3. **Terminal 3**: Local kubectl commands
4. **Terminal 4**: Log aggregation viewing

### Debugging Sessions
1. **Terminal 1**: Application logs (`tail -f app.log`)
2. **Terminal 2**: System monitoring (`htop`)
3. **Terminal 3**: Interactive debugging session
4. **Terminal 4**: Database queries

## Troubleshooting

### Terminal Not Responding
- Check the connection status in the tab indicator
- Try closing and creating a new terminal
- Refresh the page if multiple terminals are unresponsive

### Can't Create New Terminal
- Check if you've reached the maximum limit (10 by default)
- Close unused terminals to free up resources
- Check VM resource usage if all terminals are slow

### Tab Switching Is Slow
- This may occur with many terminals and large scrollback
- Try reducing the scrollback buffer size
- Close terminals you're not actively using

## Best Practices

1. **Name your tabs** - Use descriptive names for easy identification
2. **Close unused terminals** - Free up resources when done
3. **Use keyboard shortcuts** - Much faster than clicking
4. **Group related work** - Keep related commands in adjacent tabs
5. **Monitor resource usage** - Don't open more terminals than needed

## Limitations

- Maximum 10 concurrent terminals per workspace
- Sessions are not persisted across page refreshes
- No terminal splitting within tabs (use separate tabs instead)
- Shared clipboard across all terminals in the workspace