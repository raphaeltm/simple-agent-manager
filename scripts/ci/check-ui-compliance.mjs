#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const UI_PATH_PREFIXES = ['apps/web/', 'packages/vm-agent/ui/', 'packages/ui/'];
const REQUIRED_CHECKLIST_ITEMS = [
  'Mobile-first layout verified',
  'Accessibility checks completed',
  'Shared UI components used or exception documented',
];

function run(command) {
  return execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function getChangedFiles() {
  try {
    const baseRef = process.env.GITHUB_BASE_REF;
    if (baseRef) {
      return run(`git diff --name-only origin/${baseRef}...HEAD`)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    }
  } catch {
    // Fall through to local diff
  }

  try {
    return run('git diff --name-only HEAD~1 HEAD')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function isUiChange(file) {
  return UI_PATH_PREFIXES.some((prefix) => file.startsWith(prefix));
}

function getPullRequestBody() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !existsSync(eventPath)) {
    return '';
  }
  try {
    const payload = JSON.parse(readFileSync(eventPath, 'utf8'));
    return payload?.pull_request?.body || '';
  } catch {
    return '';
  }
}

const changedFiles = getChangedFiles();
const uiChangedFiles = changedFiles.filter(isUiChange);

if (uiChangedFiles.length === 0) {
  console.log('No UI file changes detected. UI compliance check passed.');
  process.exit(0);
}

console.log('UI file changes detected:');
for (const file of uiChangedFiles) {
  console.log(`- ${file}`);
}

const prBody = getPullRequestBody();
const eventName = process.env.GITHUB_EVENT_NAME || '';
if (eventName && eventName !== 'pull_request') {
  console.log(`Event "${eventName}" is not pull_request. Skipping PR checklist-body validation.`);
  process.exit(0);
}
if (!prBody) {
  console.error('UI changes detected but no pull request body was found to validate checklist evidence.');
  process.exit(1);
}

const missing = REQUIRED_CHECKLIST_ITEMS.filter((item) => !prBody.includes(item));
if (missing.length > 0) {
  console.error('Missing required UI compliance checklist items in PR description:');
  for (const item of missing) {
    console.error(`- ${item}`);
  }
  process.exit(1);
}

console.log('UI compliance checklist evidence found in PR body. Check passed.');
