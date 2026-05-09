/**
 * Prompt template loader.
 *
 * Loads markdown prompt templates from the prompts/ directory.
 * Templates override the per-scenario system prompt to test how
 * different prompting strategies affect model performance.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';

export interface PromptTemplate {
  /** Template identifier (filename without extension) */
  id: string;
  /** Template content (the system prompt) */
  content: string;
}

const PROMPTS_DIR = join(dirname(new URL(import.meta.url).pathname), 'prompts');

/**
 * Load a single prompt template by ID.
 */
export function loadTemplate(id: string): PromptTemplate {
  const filePath = join(PROMPTS_DIR, `${id}.md`);
  const content = readFileSync(filePath, 'utf-8').trim();
  return { id, content };
}

/**
 * Load all prompt templates from the prompts/ directory.
 */
export function loadAllTemplates(): PromptTemplate[] {
  const files = readdirSync(PROMPTS_DIR).filter((f) => f.endsWith('.md')).sort();
  return files.map((f) => {
    const id = basename(f, '.md');
    const content = readFileSync(join(PROMPTS_DIR, f), 'utf-8').trim();
    return { id, content };
  });
}

/**
 * Get templates by ID list, or all if no filter provided.
 */
export function getTemplates(filter?: string[]): PromptTemplate[] {
  const all = loadAllTemplates();
  if (!filter || filter.length === 0) return all;
  return all.filter((t) => filter.includes(t.id));
}
