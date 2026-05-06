/**
 * Scenario: Interpret a Test Failure
 *
 * Tests the model's ability to read test output, trace the failure to root cause,
 * and explain what went wrong — without needing to run anything.
 */

import type { EvalScenario, ScenarioRun } from '../types.js';
import { createVirtualFs, makeReadFile, makeGrep, makeGlob } from '../tools.js';

const TEST_OUTPUT = `FAIL tests/cart.test.ts
  ShoppingCart
    ✓ adds items to cart (3ms)
    ✓ removes items from cart (1ms)
    ✗ calculates total with tax (5ms)

      Expected: 108
      Received: 100

      at Object.<anonymous> (tests/cart.test.ts:28:27)

  3 tests, 1 failure
`;

const FILES = [
  {
    path: 'tests/cart.test.ts',
    content: `import { ShoppingCart } from '../src/cart';

describe('ShoppingCart', () => {
  it('adds items to cart', () => {
    const cart = new ShoppingCart();
    cart.addItem({ name: 'Widget', price: 10, quantity: 2 });
    expect(cart.items.length).toBe(1);
  });

  it('removes items from cart', () => {
    const cart = new ShoppingCart();
    cart.addItem({ name: 'Widget', price: 10, quantity: 1 });
    cart.removeItem('Widget');
    expect(cart.items.length).toBe(0);
  });

  it('calculates total with tax', () => {
    const cart = new ShoppingCart(0.08); // 8% tax
    cart.addItem({ name: 'Widget', price: 50, quantity: 2 }); // subtotal = 100
    const total = cart.getTotal(); // should be 100 * 1.08 = 108
    expect(total).toBe(108);
  });
});
`,
  },
  {
    path: 'src/cart.ts',
    content: `interface CartItem {
  name: string;
  price: number;
  quantity: number;
}

export class ShoppingCart {
  items: CartItem[] = [];
  private taxRate: number;

  constructor(taxRate = 0) {
    this.taxRate = taxRate;
  }

  addItem(item: CartItem): void {
    this.items.push(item);
  }

  removeItem(name: string): void {
    this.items = this.items.filter((i) => i.name !== name);
  }

  getSubtotal(): number {
    return this.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  }

  getTotal(): number {
    // BUG: tax is not applied — just returns subtotal
    return this.getSubtotal();
  }
}
`,
  },
  {
    path: 'test-output.txt',
    content: TEST_OUTPUT,
  },
];

const vfs = createVirtualFs(FILES);

const scenario: EvalScenario = {
  id: 'interpret-test-failure',
  name: 'Interpret a Test Failure',
  category: 'coding',
  description: 'Model reads test output and source to diagnose why a test is failing.',

  systemPrompt:
    'You are a debugging assistant. Use the provided tools to read files and search code. Diagnose test failures by examining both the test and the implementation.',

  userPrompt:
    'Our CI is failing. Read test-output.txt to see the error, then find the root cause in the source code. Explain what is wrong and how to fix it.',

  tools: [makeReadFile(vfs), makeGrep(vfs), makeGlob(vfs)],

  maxTurns: 6,

  evaluate: (run: ScenarioRun) => {
    const checks = [
      {
        name: 'read_test_output',
        pass: run.toolCalls.some(
          (tc) =>
            tc.toolName === 'read_file' &&
            /test-output/i.test(JSON.stringify(tc.arguments)),
        ),
        detail: 'Model should read the test output file',
      },
      {
        name: 'read_source',
        pass: run.toolCalls.some(
          (tc) =>
            tc.toolName === 'read_file' &&
            /cart\.ts/i.test(JSON.stringify(tc.arguments)) &&
            !tc.isError,
        ),
        detail: 'Model should read the cart source to find the bug',
      },
      {
        name: 'completed',
        pass: run.stopReason === 'complete',
        detail: 'Model should complete with a diagnosis',
      },
      {
        name: 'identifies_missing_tax',
        pass: run.messages.some(
          (m) =>
            m.role === 'assistant' &&
            !m.tool_calls?.length &&
            m.content != null &&
            /tax|taxRate|getTotal|subtotal/i.test(m.content),
        ),
        detail: 'Answer should identify that tax is not applied in getTotal',
      },
      {
        name: 'suggests_fix',
        pass: run.messages.some(
          (m) =>
            m.role === 'assistant' &&
            !m.tool_calls?.length &&
            m.content != null &&
            /1\s*\+\s*.*tax|multiply|taxRate|\*\s*\(1/i.test(m.content),
        ),
        detail: 'Answer should suggest applying the tax rate in the calculation',
      },
    ];

    const allPassed = checks.every((c) => c.pass);
    return {
      pass: allPassed,
      reason: allPassed
        ? 'Successfully diagnosed the missing tax calculation bug'
        : `Failed checks: ${checks
            .filter((c) => !c.pass)
            .map((c) => c.name)
            .join(', ')}`,
      checks,
    };
  },
};

export default scenario;
