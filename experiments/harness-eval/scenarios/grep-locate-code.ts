/**
 * Scenario: Grep to Locate Code
 *
 * Tests the model's ability to use grep to find a function, then read_file to examine it.
 * This is a core coding workflow: search-then-read.
 */

import type { EvalScenario, ScenarioRun } from '../types.js';
import { createVirtualFs, makeReadFile, makeGrep, makeGlob } from '../tools.js';

const FILES = [
  {
    path: 'src/utils/math.ts',
    content: `/**
 * Utility math functions for the billing module.
 */

export function calculateDiscount(price: number, percentage: number): number {
  if (percentage < 0 || percentage > 100) {
    throw new Error('Percentage must be between 0 and 100');
  }
  return price * (1 - percentage / 100);
}

export function roundToDecimals(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

export function formatCurrency(amount: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
}
`,
  },
  {
    path: 'src/services/billing.ts',
    content: `import { calculateDiscount, formatCurrency } from '../utils/math';

interface Invoice {
  items: Array<{ name: string; price: number; quantity: number }>;
  discountPercent: number;
}

export function generateInvoice(invoice: Invoice): string {
  let subtotal = 0;
  const lines: string[] = [];

  for (const item of invoice.items) {
    const lineTotal = item.price * item.quantity;
    subtotal += lineTotal;
    lines.push(\`  \${item.name}: \${formatCurrency(lineTotal)}\`);
  }

  const total = calculateDiscount(subtotal, invoice.discountPercent);
  lines.push(\`  Subtotal: \${formatCurrency(subtotal)}\`);
  lines.push(\`  Discount: \${invoice.discountPercent}%\`);
  lines.push(\`  Total: \${formatCurrency(total)}\`);

  return lines.join('\\n');
}
`,
  },
  {
    path: 'src/services/users.ts',
    content: `export interface User {
  id: string;
  name: string;
  email: string;
}

export function validateEmail(email: string): boolean {
  return /^[^@]+@[^@]+\\.[^@]+$/.test(email);
}
`,
  },
  {
    path: 'src/index.ts',
    content: `import { generateInvoice } from './services/billing';

const invoice = generateInvoice({
  items: [{ name: 'Widget', price: 10, quantity: 5 }],
  discountPercent: 10,
});
console.log(invoice);
`,
  },
];

const vfs = createVirtualFs(FILES);

const scenario: EvalScenario = {
  id: 'grep-locate-code',
  name: 'Grep to Locate and Read Code',
  category: 'coding',
  description: 'Model uses grep to find calculateDiscount, then reads the file to understand the function.',

  systemPrompt:
    'You are a code analysis assistant. Use the provided tools to search and read source files. Use grep to find code, then read_file to examine it in context.',

  userPrompt:
    'Find the calculateDiscount function in this project. What does it do, and which files call it?',

  tools: [makeReadFile(vfs), makeGrep(vfs), makeGlob(vfs)],

  maxTurns: 6,

  evaluate: (run: ScenarioRun) => {
    const checks = [
      {
        name: 'used_grep',
        pass: run.toolCalls.some(
          (tc) =>
            tc.toolName === 'grep' &&
            /calculateDiscount|discount/i.test(JSON.stringify(tc.arguments)),
        ),
        detail: 'Model should grep for calculateDiscount',
      },
      {
        name: 'used_read_file',
        pass: run.toolCalls.some((tc) => tc.toolName === 'read_file'),
        detail: 'Model should read at least one file for context',
      },
      {
        name: 'completed',
        pass: run.stopReason === 'complete',
        detail: 'Model should complete with an answer',
      },
      {
        name: 'identifies_function_purpose',
        pass: run.messages.some(
          (m) =>
            m.role === 'assistant' &&
            !m.tool_calls?.length &&
            m.content != null &&
            /discount|percentage|price/i.test(m.content),
        ),
        detail: 'Answer should describe the discount calculation',
      },
      {
        name: 'identifies_caller',
        pass: run.messages.some(
          (m) =>
            m.role === 'assistant' &&
            !m.tool_calls?.length &&
            m.content != null &&
            /billing|generateInvoice/i.test(m.content),
        ),
        detail: 'Answer should identify billing.ts or generateInvoice as the caller',
      },
    ];

    const allPassed = checks.every((c) => c.pass);
    return {
      pass: allPassed,
      reason: allPassed
        ? 'Successfully used grep to locate code and analyzed callers'
        : `Failed checks: ${checks
            .filter((c) => !c.pass)
            .map((c) => c.name)
            .join(', ')}`,
      checks,
    };
  },
};

export default scenario;
