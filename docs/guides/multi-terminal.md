# Multi-Terminal User Guide

## Overview

Simple Agent Manager now supports multiple terminal sessions within a single browser tab, allowing you to work with multiple terminals simultaneously without opening multiple browser tabs.

## Enabling Multi-Terminal

The multi-terminal feature is controlled by a feature flag. To enable it:

1. Set the environment variable in your `.env` file:
   ```bash
   VITE_FEATURE_MULTI_TERMINAL=true
   ```

2. Restart your development server or redeploy your application

## Using Multi-Terminal

### Creating New Terminals

- Click the **+** button in the tab bar
- Use keyboard shortcut `Ctrl+Shift+T` (or `Cmd+T` on Mac)
- Maximum of 10 concurrent terminals per workspace (configurable)

### Switching Between Terminals

- Click on any tab to switch to that terminal
- Use `Ctrl+Tab` to cycle forward through tabs
- Use `Ctrl+Shift+Tab` to cycle backward
- Use `Alt+[1-9]` to jump directly to a specific tab by number

### Closing Terminals

- Click the **×** button on the tab you want to close
- Use `Ctrl+Shift+W` (or `Cmd+W` on Mac) to close the current tab
- The system will automatically switch to an adjacent tab

### Renaming Terminals

- Double-click on a tab name to enter edit mode
- Type your new name (max 50 characters)
- Press `Enter` to save or `Escape` to cancel

## Tab Organization

### Tab Overflow

When you have more tabs than can fit in the viewport:
- Scroll arrows appear on the left/right
- Click the **⋮** menu to see all terminals in a dropdown
- The tab bar is horizontally scrollable on touch devices

### Visual Indicators

- **Active tab**: Highlighted with blue underline
- **Connected**: Normal appearance
- **Connecting**: Spinning indicator
- **Error**: Warning icon

## Keyboard Shortcuts

| Action | Windows/Linux | Mac |
|--------|--------------|-----|
| New Terminal | `Ctrl+Shift+T` | `Cmd+T` |
| Close Terminal | `Ctrl+Shift+W` | `Cmd+W` |
| Next Tab | `Ctrl+Tab` | `Cmd+Shift+]` |
| Previous Tab | `Ctrl+Shift+Tab` | `Cmd+Shift+[` |
| Jump to Tab N | `Alt+[1-9]` | `Cmd+[1-9]` |

## Configuration

Configure the multi-terminal behavior with these environment variables:

```bash
# Maximum number of concurrent terminals (default: 10)
VITE_MAX_TERMINAL_SESSIONS=10

# Tab switch animation duration in ms (default: 200)
VITE_TAB_SWITCH_ANIMATION_MS=200

# Terminal scrollback buffer size (default: 1000)
VITE_TERMINAL_SCROLLBACK_LINES=1000
```

VM Agent session lifecycle is controlled separately:

```bash
# Orphan session cleanup delay in seconds.
# 0 disables automatic cleanup (default), so sessions persist until explicitly closed.
PTY_ORPHAN_GRACE_PERIOD=0

# Output buffer size per session in bytes (default: 256 KB)
PTY_OUTPUT_BUFFER_SIZE=262144
```

## Mobile Support

The multi-terminal interface is fully responsive:

- **Touch gestures**: Swipe left/right on the tab bar to scroll
- **Tap to switch**: Tap any tab to activate it
- **Responsive design**: Tabs automatically adjust for smaller screens
- **Overflow menu**: Access all terminals via the dropdown on mobile

## Session Independence

Each terminal maintains its own:
- Working directory
- Environment variables
- Command history
- Running processes
- Scroll buffer

Switching between tabs doesn't affect running commands - they continue executing in the background.

## Performance Considerations

- Only the active terminal is rendered to the DOM (lazy rendering)
- Inactive terminals maintain their state but don't consume rendering resources
- Each terminal uses approximately 10-20MB of memory
- WebSocket connections are maintained for all terminals

## Troubleshooting

### Can't Create New Terminal
- Check if you've reached the maximum limit (10 by default)
- Verify the VM Agent is running and accepting connections
- Check browser console for WebSocket errors

### Tab Not Responding
- The terminal session may have been explicitly closed from another tab/window
- The workspace may have restarted (fresh PTY sessions are created after restart)
- Try closing and creating a new tab
- Check the connection status indicator

### Keyboard Shortcuts Not Working
- Ensure the terminal doesn't have focus (click outside the terminal area)
- Check for conflicts with browser or OS shortcuts
- Some shortcuts may differ on macOS

## Backward Compatibility

The single-terminal mode is still available when the feature flag is disabled. Your existing workflows will continue to work unchanged.

## Known Limitations

- Maximum 10 concurrent terminals (browser WebSocket limit)
- Session persistence is in-memory on the VM Agent only (lost on VM Agent restart)
- No terminal splitting/panes (use separate tabs instead)
- Cannot detach terminals into separate windows

## Best Practices

1. **Name your terminals** - Double-click to rename tabs for easy identification
2. **Close unused sessions** - Free up resources when done
3. **Use keyboard shortcuts** - Much faster than clicking
4. **Monitor resource usage** - Each terminal consumes memory and CPU
5. **Group related work** - Keep related terminals next to each other

## API Endpoints

For developers integrating with the multi-terminal system:

- `POST /api/terminal/token` - Get authentication token for terminal access

## WebSocket Protocol

The multi-terminal system uses an extended WebSocket protocol:

```javascript
// Create new session
{ type: 'create_session', data: { sessionId, rows, cols, name } }

// Close session
{ type: 'close_session', data: { sessionId } }

// Route messages to specific session
{ type: 'input', sessionId: '...', data: { data: '...' } }
```

## Future Enhancements

Planned features for future releases:
- Terminal splitting/panes within tabs
- Terminal sharing between users
- Command history search across all terminals
- Terminal recording and playback
