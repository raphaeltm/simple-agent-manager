# Voice Input & WebGL Swirl for Project Agent

## Problem
The Project Agent chat (`ProjectAgentChat.tsx`) lacks voice input and the animated WebGL swirl background that the top-level SAM chat (`SamPrototype.tsx`) has. This creates an inconsistent experience between the two agent surfaces.

## Research Findings

### Existing Code (SAM top-level agent)
- **Voice input**: `apps/web/src/pages/sam-prototype/voice-input.ts` — `useVoiceInput` hook handles MediaRecorder, amplitude monitoring, and transcription via `POST /api/transcribe`
- **WebGL background**: `apps/web/src/pages/sam-prototype/webgl-background.ts` — `useWebGLBackground` hook renders a full-screen simplex-noise-based swirl that responds to an `amplitudeRef` (0-1)
- **Integration in SAM**: `SamPrototype.tsx` wires both hooks together with a shared `amplitudeRef`, plus mic button UI with recording/processing/error states

### Target Component
- `apps/web/src/pages/ProjectAgentChat.tsx` — currently has static dark background (`rgba(2, 8, 5, 0.95)`) and only text input + send button (no mic)
- Mounted at `/projects/:id/agent` inside the Project layout shell
- Uses `useAgentChat` hook with `apiBase: /api/projects/${projectId}/agent`

### Key Differences
- ProjectAgentChat is embedded within the project shell (not full-screen like SAM)
- The voice-input and webgl-background hooks are fully reusable — no SAM-specific dependencies
- Both hooks are in `sam-prototype/` directory but can be imported directly

## Implementation Checklist

- [x] Add WebGL canvas background to ProjectAgentChat (behind content, absolute positioned)
- [x] Wire up `useWebGLBackground` hook with canvas ref and amplitude ref
- [x] Wire up `useVoiceInput` hook with transcribe URL and amplitude ref
- [x] Add mic button to input area (between textarea and send button, matching SAM style)
- [x] Add voice state indicators (recording dot, processing spinner, error message)
- [x] Import required icons (Mic, Square from lucide-react)
- [x] Update placeholder text when recording ("Speak now...")
- [x] Ensure no horizontal overflow on mobile (375px)

## Acceptance Criteria

- [x] Project Agent chat has the same WebGL swirl background as SAM top-level chat
- [x] Voice input button (mic) appears in the input area
- [x] Tapping mic records audio and transcribes to text input
- [x] WebGL swirl responds to voice amplitude during recording
- [x] Recording/processing/error states display correctly
- [x] No horizontal overflow on mobile viewports
- [x] Existing send functionality unchanged
