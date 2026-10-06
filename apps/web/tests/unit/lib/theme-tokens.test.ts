import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Ensures that CSS variables referenced across the web app are actually defined
 * in the theme tokens file. The --sam-color-bg-page variable was previously
 * undefined, causing transparent backgrounds in the SettingsDrawer and other
 * components.
 */
describe('theme token definitions', () => {
  const themeCSS = readFileSync(
    resolve(__dirname, '../../../../../packages/ui/src/tokens/theme.css'),
    'utf-8'
  );

  // Extract all defined CSS custom properties from theme.css
  const definedVars = new Set<string>();
  for (const match of themeCSS.matchAll(/--sam-[\w-]+(?=\s*:)/g)) {
    definedVars.add(match[0]);
  }

  it('defines --sam-color-bg-page', () => {
    expect(definedVars.has('--sam-color-bg-page')).toBe(true);
  });

  it('defines --sam-color-bg-overlay', () => {
    expect(definedVars.has('--sam-color-bg-overlay')).toBe(true);
  });

  it('defines --sam-color-bg-surface', () => {
    expect(definedVars.has('--sam-color-bg-surface')).toBe(true);
  });

  it('defines z-index tokens for drawers', () => {
    expect(definedVars.has('--sam-z-drawer-backdrop')).toBe(true);
    expect(definedVars.has('--sam-z-drawer')).toBe(true);
  });

  it('defines shadow tokens for overlays', () => {
    expect(definedVars.has('--sam-shadow-overlay')).toBe(true);
  });

  it('defines the glass blur feature flag token', () => {
    expect(definedVars.has('--sam-enable-blur')).toBe(true);
  });
});

describe('Slice E theme token coverage', () => {
  const repoRoot = resolve(__dirname, '../../../../..');
  const sliceEFiles = [
    'apps/web/src/pages/AgentContextPage/index.tsx',
    'apps/web/src/pages/AgentContextPage/MemoryTab.tsx',
    'apps/web/src/pages/AgentContextPage/PoliciesTab.tsx',
    'apps/web/src/pages/AgentContextPage/ActionsTab.tsx',
    'apps/web/src/pages/ProjectSettings.tsx',
    'apps/web/src/pages/ProjectLibrary.tsx',
    'apps/web/src/pages/ProjectNotifications.tsx',
    'apps/web/src/pages/IdeasPage.tsx',
    'apps/web/src/pages/IdeaDetailPage.tsx',
    'apps/web/src/pages/ProjectTriggers.tsx',
    'apps/web/src/pages/ProjectTriggerDetail.tsx',
    'apps/web/src/components/library/CreateDirectoryDialog.tsx',
    'apps/web/src/components/library/FileGridCard.tsx',
    'apps/web/src/components/library/FileListItem.tsx',
    'apps/web/src/components/library/FilePreviewModal.tsx',
    'apps/web/src/components/library/LibraryToolbar.tsx',
    'apps/web/src/components/library/TagEditor.tsx',
    'apps/web/src/components/library/UploadProgressChips.tsx',
    'apps/web/src/components/project/TaskDelegateDialog.tsx',
    'apps/web/src/components/triggers/SchedulePicker.tsx',
    'apps/web/src/components/NotificationCenter.tsx',
  ];

  const forbiddenPatterns = [
    /bg-\[rgba\(8,15,12,/,
    /bg-black\//,
    /text-white(?:\s|`|'|")/,
    /color:\s*['"]white['"]/,
    /backgroundColor:\s*['"]white['"]/,
    /shadow-black\//,
    /border-\[rgba\(34,197,94,/,
    /text-(?:red|amber|blue|sky|emerald|purple|pink|zinc)-\d/,
    /bg-(?:red|amber|blue|sky|emerald|purple|pink|zinc)-\d/,
    /border-(?:red|amber|blue|sky|emerald|purple|pink|zinc)-\d/,
  ];

  it('keeps converted Slice E surfaces free of hardcoded dark theme literals', () => {
    const violations: string[] = [];

    for (const relativePath of sliceEFiles) {
      const source = readFileSync(resolve(repoRoot, relativePath), 'utf-8');
      for (const pattern of forbiddenPatterns) {
        if (pattern.test(source)) {
          violations.push(`${relativePath}: ${pattern}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
