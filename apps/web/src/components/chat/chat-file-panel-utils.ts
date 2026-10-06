// Pure path/format helpers for ChatFilePanel. Split out of ChatFilePanel.tsx
// (see .claude/rules/18-file-size-limits.md) — pure extraction, no behavior change.

export function isMarkdownFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.mdx');
}

export interface BreadcrumbItem {
  label: string;
  path: string;
}

export function buildBreadcrumbs(dirPath: string): BreadcrumbItem[] {
  const crumbs: BreadcrumbItem[] = [{ label: '/', path: '.' }];
  if (dirPath === '.' || dirPath === '' || dirPath === '/') return crumbs;
  let normalized = dirPath;
  if (normalized.startsWith('./')) normalized = normalized.slice(2);
  if (normalized.startsWith('/')) normalized = normalized.slice(1);
  const parts = normalized.split('/').filter(Boolean);
  let accumulated = '';
  for (const part of parts) {
    accumulated = accumulated ? `${accumulated}/${part}` : part;
    crumbs.push({ label: part, path: accumulated });
  }
  return crumbs;
}
