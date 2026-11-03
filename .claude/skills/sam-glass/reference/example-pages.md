# SAM Glass example screens

Region by region, as designed on the "SAM Glass Workspace Explorations" canvas. Content and labels come from the app; sample people, machines and some automation names are made up.

## Desktop chat with teammates (canvas: A1 · Multiplayer)

Void, then four panes left to right:

1. **Sidebar pane** (about 15rem): logo; Recent chats and Notifications icon buttons with counts; search well with ⌘K; "Back to Projects"; project name as a mono label; project nav items (Chat current, Comments with an attention count); layout segmented control (Default / Focus / Zen); user row.
2. **Chat list pane** (about 19rem): project name, history and settings buttons; New Chat; search well; one row: segmented Mine 3 / Others 7 / All 10 plus a 22px overlapping stack of teammate avatars that filter to one person; session rows (see the guide's "Chat list").
3. **Conversation column**: info slab (title, chips: Active, Lightweight, Claude · 5h with a usage bar, Shared with project, Comments; avatars of people with access; Share button); message history pane with a teammate's message tinted in their colour and a comment pane laid over the edge of the assistant's reply; message box slab ("Jonas is writing a message", attach, textarea well, dictate, Send).
4. **Tool rail pane** (3.75rem): icon buttons.

## Mobile chat and chat list (canvas: Mobile · Chat, Mobile · Chat list)

App bar slab (menu, logo, project name, Recent chats + Notifications in a well, chat list button raised), session info slab (two-line title, Active and Claude chips, avatars + share), conversation, message box slab. The chat list is a drawer from the right with live blur (the only one on screen), over the dimmed chat: Chats + close, search + New chat, Mine / Others / All at 40px, person filter row shown only under Others, then session rows at least 60px tall.

## Project settings → Access

Project sidebar (Settings current). Header slab: "SAM / Settings", "Project settings", tabs General, Access (current), Accounts, Agents, Infrastructure, Runtime, Deploy. Left pane "Members": table of person (32px avatar, name, joined), GitHub chip, role select (Owner shown as a chip), Remove; "Transfer ownership" setting row. Right column: "Invite link" (notice + Create invite link), "Pending requests" (Approve / Deny), "Credential checklist before sharing" (agent account billed to you, cloud account, GitHub).

## Project → Automation

Header slab with subtitle "Work that starts on its own: on a schedule, when something happens, or as the next step of a workflow.", tabs Overview / History / Workflows / Behind the scenes, primary "New automation". "Needs your attention" pane with an amber edge and glow. "Your automations" table (name and what it does, kind chip, who set it up, last run chip, on/off switch) with Live / Finished. Right column: Coming up (time in mono), Recently (status dots), Behind the scenes (Watches, Agent channels).

## Settings → Agents

Global sidebar (Settings current). Header slab with tabs Agents, Infrastructure, GitHub, MCP servers, Notifications, Usage, Access, Advanced. "Agent accounts" section title with By provider / By project; a pane per agent (Claude Code, OpenAI Codex) with account setting rows (name, Default or Needs attention chip, kind, which projects use it, action); "Not connected" pane of wells with Connect. "Agent settings" pane of setting rows.

## Settings → Infrastructure

"Cloud accounts" panes per provider and a Not connected pane. "Node pool" section: "Your compute pool" pane with a running chip and Refresh; four fields in a grid (Placing agents, Machine limit, If the provider is out of capacity, App deployments) with the app's help text; "Allowed machines" table.

## Admin → Shared compute pool, Admin → Users

Global sidebar (Admin current), then an admin sections pane grouped People / Platform / Spend / Health (nav items, 34px), then content. Shared compute pool: header slab with Edit pool; warning notice with Refresh; a pane of the pool's four settings as label, value and explanation; "Machines now" and "Allowed machines" tables. Users: "Signup approval" setting row with a switch; "People" pane with search, All / Active / Pending / Suspended with counts, and a table (avatar, name, email in mono, role select, state chip, joined, Approve / Restore / Suspend).
