import { readFileSync } from 'node:fs';

/**
 * CI quality check: validates the Specialist Review Evidence table in PR bodies.
 *
 * Fails if:
 * 1. Any reviewer has DISPATCHED or FAILED status (incomplete reviews)
 * 2. The `needs-human-review` label is present on the PR
 * 3. The review evidence table is missing/empty on agent-authored PRs
 *
 * Passes for human-authored PRs without the table.
 */

const SECTION_HEADING = '## Specialist Review Evidence';
const TABLE_HEADER_PATTERN = /\|\s*Reviewer\s*\|\s*Status\s*\|\s*Outcome\s*\|/i;
const TABLE_SEPARATOR_PATTERN = /\|\s*-+\s*\|\s*-+\s*\|\s*-+\s*\|/;
const HUMAN_AUTHORED_MARKER = /N\/A:\s*human-authored\s*PR/i;
const AGENT_AUTHORED_PATTERN = /Co-Authored-By:\s*Claude/i;
const NEEDS_HUMAN_REVIEW_LABEL = 'needs-human-review';

// Blocking statuses — reviews that have not completed
const BLOCKING_STATUSES = ['DISPATCHED', 'FAILED'] as const;

// Acceptable statuses — reviews that are complete
const ACCEPTABLE_STATUSES = ['PASS', 'ADDRESSED', 'DEFERRED'] as const;

export interface ReviewRow {
  reviewer: string;
  status: string;
  outcome: string;
}

export interface CheckResult {
  pass: boolean;
  failures: string[];
  warnings: string[];
  reviewers: ReviewRow[];
}

function fail(message: string): never {
  console.error(`\nSpecialist review evidence check failed:\n- ${message}\n`);
  process.exit(1);
}

/**
 * Extract the Specialist Review Evidence section from PR body.
 */
export function extractReviewSection(body: string): string | null {
  const sectionIndex = body.indexOf(SECTION_HEADING);
  if (sectionIndex === -1) return null;

  const afterHeading = body.slice(sectionIndex + SECTION_HEADING.length);
  // Section ends at the next ## heading or end of string
  const nextSectionMatch = afterHeading.match(/\n## [^#]/);
  const sectionContent = nextSectionMatch
    ? afterHeading.slice(0, nextSectionMatch.index)
    : afterHeading;

  return sectionContent.trim();
}

/**
 * Parse table rows from the review section.
 * Returns rows found after the header + separator lines.
 */
export function parseReviewTable(section: string): ReviewRow[] {
  const lines = section.split('\n').map((l) => l.trim());
  const rows: ReviewRow[] = [];

  let foundHeader = false;
  let foundSeparator = false;

  for (const line of lines) {
    if (!foundHeader) {
      if (TABLE_HEADER_PATTERN.test(line)) {
        foundHeader = true;
      }
      continue;
    }

    if (!foundSeparator) {
      if (TABLE_SEPARATOR_PATTERN.test(line)) {
        foundSeparator = true;
      }
      continue;
    }

    // Parse data rows
    if (!line.startsWith('|')) continue;

    const cells = line
      .split('|')
      .map((c) => c.trim())
      .filter((c) => c.length > 0);

    if (cells.length < 3) continue;

    const [reviewer, status, ...outcomeParts] = cells;
    const outcome = outcomeParts.join(' | ');

    // Skip comment/template rows
    if (reviewer.startsWith('<!--') || status.startsWith('<!--')) continue;

    rows.push({
      reviewer: reviewer.replace(/<!--.*?-->/g, '').trim(),
      status: status.replace(/<!--.*?-->/g, '').trim().toUpperCase(),
      outcome: outcome.replace(/<!--.*?-->/g, '').trim(),
    });
  }

  return rows;
}

/**
 * Determine if the PR is agent-authored by checking the body for Co-Authored-By: Claude.
 */
export function isAgentAuthored(body: string): boolean {
  return AGENT_AUTHORED_PATTERN.test(body);
}

/**
 * Determine if the review section explicitly says N/A: human-authored PR.
 */
export function isExplicitHumanNA(section: string): boolean {
  return HUMAN_AUTHORED_MARKER.test(section);
}

/**
 * Check if the PR has the needs-human-review label.
 */
export function hasNeedsHumanReviewLabel(labels: Array<{ name: string }>): boolean {
  return labels.some((l) => l.name === NEEDS_HUMAN_REVIEW_LABEL);
}

/**
 * Main validation logic — separated from I/O for testability.
 */
export function validateReviewEvidence(
  body: string,
  labels: Array<{ name: string }>
): CheckResult {
  const result: CheckResult = {
    pass: true,
    failures: [],
    warnings: [],
    reviewers: [],
  };

  // Check 1: needs-human-review label
  if (hasNeedsHumanReviewLabel(labels)) {
    result.pass = false;
    result.failures.push(
      'PR has the "needs-human-review" label. A human must review and remove this label before merging.'
    );
    return result;
  }

  // Check 2: Extract review section
  const section = extractReviewSection(body);

  // If no section found, check if this is an agent-authored PR
  if (!section) {
    if (isAgentAuthored(body)) {
      result.pass = false;
      result.failures.push(
        'Agent-authored PR is missing the "Specialist Review Evidence" section. ' +
          'All agent-authored PRs must include review evidence.'
      );
    }
    // Human-authored PRs without the section are fine
    return result;
  }

  // Check for explicit N/A: human-authored PR
  if (isExplicitHumanNA(section)) {
    return result;
  }

  // Check 3: Parse the table
  const reviewers = parseReviewTable(section);
  result.reviewers = reviewers;

  // Empty table on agent-authored PR
  if (reviewers.length === 0) {
    if (isAgentAuthored(body)) {
      result.pass = false;
      result.failures.push(
        'Agent-authored PR has an empty Specialist Review Evidence table. ' +
          'All dispatched reviewers must be listed with their status.'
      );
    }
    return result;
  }

  // Check 4: Validate each reviewer's status
  for (const row of reviewers) {
    const normalizedStatus = row.status.toUpperCase();

    if (BLOCKING_STATUSES.includes(normalizedStatus as (typeof BLOCKING_STATUSES)[number])) {
      result.pass = false;
      result.failures.push(
        `Reviewer "${row.reviewer}" has blocking status: ${normalizedStatus}. ` +
          'This reviewer must complete before merge.'
      );
    } else if (normalizedStatus === 'DEFERRED') {
      result.warnings.push(
        `Reviewer "${row.reviewer}" has DEFERRED findings. Ensure deferral is justified.`
      );
    } else if (
      !ACCEPTABLE_STATUSES.includes(normalizedStatus as (typeof ACCEPTABLE_STATUSES)[number])
    ) {
      result.pass = false;
      result.failures.push(
        `Reviewer "${row.reviewer}" has unrecognized status: "${row.status}". ` +
          `Expected one of: ${[...BLOCKING_STATUSES, ...ACCEPTABLE_STATUSES].join(', ')}.`
      );
    }
  }

  return result;
}

function main(): void {
  const eventName = process.env.GITHUB_EVENT_NAME;
  if (eventName !== 'pull_request' && eventName !== 'pull_request_target') {
    console.log('Skipping specialist review evidence check: not a pull request event.');
    return;
  }

  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    fail('GITHUB_EVENT_PATH is missing.');
  }

  const payload = JSON.parse(readFileSync(eventPath, 'utf8')) as {
    pull_request?: {
      body?: string | null;
      html_url?: string;
      labels?: Array<{ name: string }>;
    };
  };

  const body = payload.pull_request?.body ?? '';
  const labels = payload.pull_request?.labels ?? [];

  if (!body.trim()) {
    // Empty body — defer to preflight evidence check to flag this
    console.log('Skipping specialist review evidence check: PR body is empty.');
    return;
  }

  const result = validateReviewEvidence(body, labels);

  // Print warnings
  for (const warning of result.warnings) {
    console.warn(`Warning: ${warning}`);
  }

  if (!result.pass) {
    console.error('\nSpecialist review evidence check failed:\n');
    for (const issue of result.failures) {
      console.error(`- ${issue}`);
    }
    console.error('\nFix the PR review evidence section and re-run CI.\n');
    console.error(
      'If reviewers are still in progress, wait for them to complete before merging.\n' +
        'If a reviewer cannot complete, add the "needs-human-review" label and let a human decide.\n'
    );
    process.exit(1);
  }

  console.log('Specialist review evidence check passed.');
  if (result.reviewers.length > 0) {
    console.log(
      `Reviewers: ${result.reviewers.map((r) => `${r.reviewer} (${r.status})`).join(', ')}`
    );
  }
  if (payload.pull_request?.html_url) {
    console.log(`PR: ${payload.pull_request.html_url}`);
  }
}

main();
