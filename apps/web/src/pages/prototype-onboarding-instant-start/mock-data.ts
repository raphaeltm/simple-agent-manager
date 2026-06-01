/**
 * PROTOTYPE ONLY — DO NOT SHIP TO PRODUCTION
 * Mock data for the Instant Start onboarding prototype.
 */

export const SAMPLE_REPOS = [
  {
    id: 'template-nextjs',
    name: 'Next.js Starter',
    description: 'A modern Next.js 15 app with Tailwind CSS and TypeScript',
    language: 'TypeScript',
    stars: '12.4k',
    icon: 'N',
  },
  {
    id: 'template-express',
    name: 'Express API',
    description: 'REST API with Express, Prisma, and PostgreSQL',
    language: 'TypeScript',
    stars: '8.1k',
    icon: 'E',
  },
  {
    id: 'template-python',
    name: 'FastAPI Backend',
    description: 'Python API with FastAPI, SQLAlchemy, and Alembic',
    language: 'Python',
    stars: '15.2k',
    icon: 'F',
  },
  {
    id: 'own-repo',
    name: 'My own repo',
    description: 'I have a GitHub repo I want to use',
    language: '',
    stars: '',
    icon: '+',
  },
];

export const TASK_SUGGESTIONS = [
  {
    title: 'Add a feature',
    examples: [
      'Add a dark mode toggle',
      'Add user authentication with JWT',
      'Add a search bar with filtering',
    ],
  },
  {
    title: 'Fix a bug',
    examples: [
      'Fix the mobile navigation menu',
      'Fix the form validation errors',
      'Fix the image loading on slow connections',
    ],
  },
  {
    title: 'Improve code',
    examples: [
      'Add TypeScript types to the API routes',
      'Write tests for the user service',
      'Refactor the database queries for performance',
    ],
  },
];

export const MOCK_CHAT_MESSAGES = [
  {
    role: 'user' as const,
    content: 'Add a dark mode toggle to the settings page',
    timestamp: '10:32 AM',
  },
  {
    role: 'agent' as const,
    content:
      "I'll add a dark mode toggle to the settings page. Let me start by examining the current settings component and the app's theming setup.\n\nFirst, I'll check the existing settings page structure...",
    timestamp: '10:32 AM',
    status: 'thinking',
  },
  {
    role: 'agent' as const,
    content:
      "I found the settings page at `src/pages/Settings.tsx`. The app uses Tailwind CSS with a `dark:` variant but doesn't have a toggle yet. I'll:\n\n1. Create a `useTheme` hook for dark mode state\n2. Add a toggle component to settings\n3. Wire it up to the document root class\n\nLet me create the hook first...",
    timestamp: '10:33 AM',
    status: 'working',
    toolCalls: ['Read src/pages/Settings.tsx', 'Read tailwind.config.ts'],
  },
  {
    role: 'agent' as const,
    content:
      "Created `src/hooks/useTheme.ts` with localStorage persistence. Now adding the toggle to the settings page with a smooth transition animation.\n\nRunning tests... All 47 tests pass.",
    timestamp: '10:35 AM',
    status: 'working',
    toolCalls: [
      'Write src/hooks/useTheme.ts',
      'Edit src/pages/Settings.tsx',
      'Run npm test',
    ],
  },
  {
    role: 'agent' as const,
    content:
      "Done! I've opened PR #42: \"Add dark mode toggle to settings\"\n\n**Changes:**\n- New `useTheme` hook with localStorage persistence\n- Toggle component in settings with smooth transition\n- All 47 tests passing\n\nThe PR is ready for review.",
    timestamp: '10:37 AM',
    status: 'complete',
    toolCalls: ['Run git push', 'Create PR #42'],
  },
];

export interface ProgressStep {
  id: string;
  label: string;
  detail: string;
  duration: number; // ms to simulate
}

export const PROVISIONING_STEPS: ProgressStep[] = [
  {
    id: 'vm',
    label: 'Creating workspace',
    detail: 'Spinning up a cloud VM in Frankfurt',
    duration: 2000,
  },
  {
    id: 'clone',
    label: 'Cloning repository',
    detail: 'Pulling latest from main branch',
    duration: 1500,
  },
  {
    id: 'deps',
    label: 'Installing dependencies',
    detail: 'Running npm install (342 packages)',
    duration: 2500,
  },
  {
    id: 'agent',
    label: 'Starting Claude Code',
    detail: 'Agent ready and connected',
    duration: 1000,
  },
];
