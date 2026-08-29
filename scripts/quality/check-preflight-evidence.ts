import { readFileSync } from 'node:fs';
import * as v from 'valibot';

const PREFLIGHT_START = '<!-- AGENT_PREFLIGHT_START -->';
const PREFLIGHT_END = '<!-- AGENT_PREFLIGHT_END -->';

const CLASSIFICATIONS = [
  'external-api-change',
  'cross-component-change',
  'business-logic-change',
  'public-surface-change',
  'docs-sync-change',
  'security-sensitive-change',
  'ui-change',
  'infra-change',
] as const;

const SCREENSHOT_LINK_PATTERN =
  /!\[[^\]]+\]\([^)]+\)|https?:\/\/\S+\.(?:png|jpg|jpeg|webp)(?:\?\S*)?|#issuecomment-\d+/i;

const SURFACE_HEADING_PATTERN = /^#{4,6}\s+Surface:\s+(.+)\s*$/i;

const STRESS_DATA_PATTERN =
  /\b(mock|edge|stress|long text|many items|empty|error|special characters|push(?:es|ed)? the limits)\b/i;

const QC_REVIEW_PATTERN = /\b(reviewed|inspected)\b/i;

const QC_RESULT_PATTERN =
  /\b(no issues|no visual issues|quality|overflow|clipping|layout|found|fixed|documented)\b/i;

function fail(message: string): never {
  console.error(`\nPreflight evidence check failed:\n- ${message}\n`);
  process.exit(1);
}

const pullRequestPayloadSchema = v.object({
  pull_request: v.object({
    body: v.optional(v.nullable(v.string())),
    html_url: v.optional(v.string()),
  }),
});

function parsePullRequestPayload(raw: string): { body: string; htmlUrl?: string } {
  const payload: unknown = JSON.parse(raw);
  const result = v.safeParse(pullRequestPayloadSchema, payload);
  if (!result.success) {
    fail(
      'GitHub event payload must include pull_request with a string body/html_url when present.'
    );
  }

  const pullRequest = result.output.pull_request;
  return {
    body: pullRequest.body ?? '',
    ...(pullRequest.html_url ? { htmlUrl: pullRequest.html_url } : {}),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getSectionContent(block: string, heading: string): string | null {
  const pattern = new RegExp(
    `### ${escapeRegExp(heading)}\\s*([\\s\\S]*?)(?=\\n### |\\n${escapeRegExp(PREFLIGHT_END)})`,
    'i'
  );
  const match = block.match(pattern);
  return match?.[1]?.trim() ?? null;
}

function getMarkdownSectionContent(body: string, heading: string): string | null {
  const pattern = new RegExp(
    `(?:^|\\n)#{2,3} ${escapeRegExp(heading)}\\s*([\\s\\S]*?)(?=\\n#{2,3} |\\n${escapeRegExp(PREFLIGHT_START)}|\\s*$)`,
    'i'
  );
  const match = body.match(pattern);
  return match?.[1]?.trim() ?? null;
}

function hasCheckedLine(block: string, text: string): boolean {
  const pattern = new RegExp(`- \\[[xX]\\] ${escapeRegExp(text)}`, 'i');
  return pattern.test(block);
}

function getCheckedClasses(block: string): string[] {
  return CLASSIFICATIONS.filter((classification) => {
    const pattern = new RegExp(`- \\[[xX]\\] ${escapeRegExp(classification)}`, 'i');
    return pattern.test(block);
  });
}

/**
 * Splits the `UI Screenshot Evidence` section into per-surface blocks. Each block
 * starts at a `#### Surface: <name>` heading and runs until the next such heading.
 * Returns an empty array when the section does not enumerate surfaces, which the
 * caller treats as an invalid global-only evidence layout.
 */
function extractSurfaceBlocks(section: string): Array<{ name: string; block: string }> {
  const lines = section.split('\n');
  const headings: Array<{ index: number; name: string }> = [];
  for (const [index, line] of lines.entries()) {
    const match = line.match(SURFACE_HEADING_PATTERN);
    if (match) headings.push({ index, name: match[1].trim() });
  }
  if (headings.length === 0) return [];

  return headings.map((heading, i) => ({
    name: heading.name,
    block: lines
      .slice(heading.index + 1, headings[i + 1]?.index)
      .join('\n')
      .trim(),
  }));
}

/**
 * Returns the single-line value of a `- <label>: <value>` field inside a surface
 * block. Returns an empty string when the field is absent or has no value.
 */
function getSurfaceFieldValue(block: string, label: string): string {
  const pattern = new RegExp(`-\\s*${escapeRegExp(label)}\\s*:\\s*(.+)\\s*$`, 'im');
  for (const line of block.split('\n')) {
    const match = line.match(pattern);
    if (match) return match[1].trim();
  }
  return '';
}

function isExplicitNA(content: string): boolean {
  return /^N\/A:\s+\S+/i.test(content);
}

function hasPlaceholder(content: string): boolean {
  const placeholders = [
    'Provide sources consulted before coding',
    'List affected components and code paths',
    'List docs/spec files updated',
    'State which constitution principles were checked',
  ];

  return placeholders.some((placeholder) => content.includes(placeholder));
}

function validateSection(name: string, content: string | null, failures: string[]): void {
  if (!content) {
    failures.push(`Missing section content for "${name}".`);
    return;
  }

  if (hasPlaceholder(content)) {
    failures.push(`Section "${name}" still contains template placeholder text.`);
    return;
  }

  const compact = content.replace(/\s+/g, ' ').trim();
  if (!isExplicitNA(content) && compact.length < 24) {
    failures.push(`Section "${name}" is too short to be useful evidence.`);
  }
}

function main(): void {
  const eventName = process.env.GITHUB_EVENT_NAME;
  if (eventName !== 'pull_request' && eventName !== 'pull_request_target') {
    console.log('Skipping preflight evidence check: not a pull request event.');
    return;
  }

  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    fail('GITHUB_EVENT_PATH is missing.');
  }

  const payload = parsePullRequestPayload(readFileSync(eventPath, 'utf8'));

  const body = payload.body;
  if (!body.trim()) {
    fail('Pull request body is empty. Fill the PR template, including Agent Preflight evidence.');
  }

  const startIndex = body.indexOf(PREFLIGHT_START);
  const endIndex = body.indexOf(PREFLIGHT_END);
  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    fail('Missing or malformed Agent Preflight block markers in PR body.');
  }

  const block = body.slice(startIndex, endIndex + PREFLIGHT_END.length);
  const failures: string[] = [];

  if (!hasCheckedLine(block, 'Preflight completed before code changes')) {
    failures.push('The preflight completion checkbox is not checked.');
  }

  const checkedClasses = getCheckedClasses(block);
  if (checkedClasses.length === 0) {
    failures.push('At least one preflight classification must be checked.');
  }

  const externalRefs = getSectionContent(block, 'External References');
  const impactAnalysis = getSectionContent(block, 'Codebase Impact Analysis');
  const docUpdates = getSectionContent(block, 'Documentation & Specs');
  const constitutionCheck = getSectionContent(block, 'Constitution & Risk Check');

  validateSection('External References', externalRefs, failures);
  validateSection('Codebase Impact Analysis', impactAnalysis, failures);
  validateSection('Documentation & Specs', docUpdates, failures);
  validateSection('Constitution & Risk Check', constitutionCheck, failures);

  if (checkedClasses.includes('external-api-change')) {
    if (!externalRefs || isExplicitNA(externalRefs)) {
      failures.push(
        'external-api-change requires filled External References (N/A is not allowed).'
      );
    } else {
      const hasDocSource = /(context7|official docs|official documentation)/i.test(externalRefs);
      const hasUrl = /https?:\/\//i.test(externalRefs);
      if (!hasDocSource) {
        failures.push(
          'external-api-change requires mentioning Context7 or official documentation in External References.'
        );
      }
      if (!hasUrl) {
        failures.push(
          'external-api-change requires at least one source URL in External References.'
        );
      }
    }
  }

  if (checkedClasses.includes('cross-component-change')) {
    if (!impactAnalysis || isExplicitNA(impactAnalysis)) {
      failures.push(
        'cross-component-change requires a concrete Codebase Impact Analysis (N/A is not allowed).'
      );
    } else if (!/(apps\/|packages\/|scripts\/|infra\/|docs\/|specs\/)/i.test(impactAnalysis)) {
      failures.push(
        'cross-component-change impact analysis must reference concrete repo paths (apps/, packages/, scripts/, infra/, docs/, specs/).'
      );
    }
  }

  if (
    checkedClasses.includes('public-surface-change') ||
    checkedClasses.includes('docs-sync-change')
  ) {
    if (!docUpdates || isExplicitNA(docUpdates)) {
      failures.push(
        'public-surface-change/docs-sync-change requires concrete Documentation & Specs updates (N/A is not allowed).'
      );
    }
  }

  if (checkedClasses.includes('ui-change')) {
    const uiScreenshots = getMarkdownSectionContent(body, 'UI Screenshot Evidence');
    if (!uiScreenshots || isExplicitNA(uiScreenshots)) {
      failures.push(
        'ui-change requires a filled "UI Screenshot Evidence" section with per-surface desktop/mobile Playwright screenshots and review attestation.'
      );
    } else {
      if (!/\bplaywright\b/i.test(uiScreenshots)) {
        failures.push(
          'UI Screenshot Evidence must state that screenshots were taken with Playwright.'
        );
      }

      const surfaces = extractSurfaceBlocks(uiScreenshots);
      if (surfaces.length === 0) {
        failures.push(
          'UI Screenshot Evidence must enumerate every changed UI surface under a "#### Surface: <name>" heading with desktop and mobile evidence per surface. Global-only desktop/mobile links cannot satisfy per-surface evidence.'
        );
      }

      for (const surface of surfaces) {
        const desktop = getSurfaceFieldValue(surface.block, 'Desktop evidence');
        const mobile = getSurfaceFieldValue(surface.block, 'Mobile evidence');
        const stressData = getSurfaceFieldValue(surface.block, 'Mock/stress data used');
        const qualityReview = getSurfaceFieldValue(surface.block, 'Screenshot quality review');

        if (!desktop || !SCREENSHOT_LINK_PATTERN.test(desktop)) {
          failures.push(
            `Surface "${surface.name}" is missing desktop screenshot evidence (a "Desktop evidence:" line with an image link or #issuecomment-... URL).`
          );
        }
        if (!mobile || !SCREENSHOT_LINK_PATTERN.test(mobile)) {
          failures.push(
            `Surface "${surface.name}" is missing mobile screenshot evidence (a "Mobile evidence:" line with an image link or #issuecomment-... URL).`
          );
        }
        if (!stressData || !STRESS_DATA_PATTERN.test(stressData)) {
          failures.push(
            `Surface "${surface.name}" must describe the mock/stress data used to push the surface (for example long text, many items, empty, error, special characters).`
          );
        }
        if (
          !qualityReview ||
          !QC_REVIEW_PATTERN.test(qualityReview) ||
          !QC_RESULT_PATTERN.test(qualityReview)
        ) {
          failures.push(
            `Surface "${surface.name}" must explicitly attest that its screenshots were reviewed for quality and note the result.`
          );
        }
      }
    }
  }

  if (failures.length > 0) {
    console.error('\nPreflight evidence check failed:\n');
    for (const issue of failures) {
      console.error(`- ${issue}`);
    }
    console.error('\nFix the PR preflight section and re-run CI.\n');
    process.exit(1);
  }

  console.log('Preflight evidence check passed.');
  console.log(`Checked classes: ${checkedClasses.join(', ')}`);
  if (payload.htmlUrl) {
    console.log(`PR: ${payload.htmlUrl}`);
  }
}

main();
