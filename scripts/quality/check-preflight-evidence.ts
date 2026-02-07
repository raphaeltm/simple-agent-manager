import { readFileSync } from 'node:fs';

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

function fail(message: string): never {
  console.error(`\nPreflight evidence check failed:\n- ${message}\n`);
  process.exit(1);
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

  const payload = JSON.parse(readFileSync(eventPath, 'utf8')) as {
    pull_request?: { body?: string | null; html_url?: string };
  };

  const body = payload.pull_request?.body ?? '';
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
  if (payload.pull_request?.html_url) {
    console.log(`PR: ${payload.pull_request.html_url}`);
  }
}

main();
