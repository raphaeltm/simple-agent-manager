/**
 * Scenario: Test-Driven Fix
 *
 * Given a failing test and the implementation, the model must read the test
 * to understand the expected behavior, then fix the implementation to make
 * the test pass.
 */

import type { EvalScenario, ScenarioRun } from '../types.js';
import { createVirtualFs, makeReadFile, makeEditFile, makeGrep, makeGlob } from '../tools.js';

const FILES = [
  {
    path: 'src/cart.ts',
    content: `export interface CartItem {
  id: string;
  name: string;
  price: number;
  quantity: number;
}

export interface Cart {
  items: CartItem[];
  discount: number; // percentage, e.g. 10 means 10%
}

/**
 * Calculate the total price of the cart after applying the discount.
 * BUG: discount is applied per-item instead of to the total.
 * This causes rounding errors and incorrect totals when
 * items have different prices.
 */
export function calculateTotal(cart: Cart): number {
  let total = 0;
  for (const item of cart.items) {
    const itemTotal = item.price * item.quantity;
    // BUG: applying discount per-item loses precision
    const discounted = itemTotal * (1 - cart.discount / 100);
    total += Math.round(discounted * 100) / 100;
  }
  return total;
}

/**
 * Add an item to the cart. If the item already exists, increase quantity.
 */
export function addItem(cart: Cart, item: Omit<CartItem, 'quantity'>, qty = 1): Cart {
  const existing = cart.items.find((i) => i.id === item.id);
  if (existing) {
    return {
      ...cart,
      items: cart.items.map((i) =>
        i.id === item.id ? { ...i, quantity: i.quantity + qty } : i
      ),
    };
  }
  return {
    ...cart,
    items: [...cart.items, { ...item, quantity: qty }],
  };
}
`,
  },
  {
    path: 'tests/cart.test.ts',
    content: `import { calculateTotal, addItem, Cart } from '../src/cart';

describe('calculateTotal', () => {
  it('calculates total without discount', () => {
    const cart: Cart = {
      items: [
        { id: '1', name: 'Widget', price: 10.00, quantity: 2 },
        { id: '2', name: 'Gadget', price: 25.00, quantity: 1 },
      ],
      discount: 0,
    };
    expect(calculateTotal(cart)).toBe(45.00);
  });

  it('applies discount to the total, not per-item', () => {
    // This test FAILS because discount is applied per-item
    // causing rounding differences.
    const cart: Cart = {
      items: [
        { id: '1', name: 'Widget', price: 9.99, quantity: 3 },  // 29.97
        { id: '2', name: 'Gadget', price: 14.99, quantity: 2 }, // 29.98
      ],
      discount: 15,
    };
    // Correct: (29.97 + 29.98) * 0.85 = 50.9575 => 50.96
    // Bug:     round(29.97*0.85) + round(29.98*0.85) = 25.47 + 25.48 = 50.95
    expect(calculateTotal(cart)).toBe(50.96);
  });

  it('handles empty cart', () => {
    const cart: Cart = { items: [], discount: 10 };
    expect(calculateTotal(cart)).toBe(0);
  });
});

describe('addItem', () => {
  it('adds a new item', () => {
    const cart: Cart = { items: [], discount: 0 };
    const updated = addItem(cart, { id: '1', name: 'Widget', price: 10 });
    expect(updated.items).toHaveLength(1);
    expect(updated.items[0].quantity).toBe(1);
  });

  it('increments quantity of existing item', () => {
    const cart: Cart = {
      items: [{ id: '1', name: 'Widget', price: 10, quantity: 2 }],
      discount: 0,
    };
    const updated = addItem(cart, { id: '1', name: 'Widget', price: 10 }, 3);
    expect(updated.items[0].quantity).toBe(5);
  });
});
`,
  },
];

const vfs = createVirtualFs(FILES);

const scenario: EvalScenario = {
  id: 'test-driven-fix',
  name: 'Fix Implementation to Pass Failing Test',
  category: 'coding',
  description:
    'A test expects discount to be applied to the cart total, but the implementation applies it per-item. Fix calculateTotal.',

  systemPrompt:
    'You are a test-driven development assistant. Read the failing test to understand expected behavior, then fix the implementation. Use tools to read files and make edits.',

  userPrompt:
    'The test "applies discount to the total, not per-item" in tests/cart.test.ts is failing. Read the test and the implementation, then fix calculateTotal in src/cart.ts so the test passes.',

  tools: [makeReadFile(vfs), makeEditFile(vfs), makeGrep(vfs), makeGlob(vfs)],

  maxTurns: 8,

  evaluate: (run: ScenarioRun) => {
    const cartContent = vfs.get('src/cart.ts') ?? '';

    // The fix should sum items first, then apply discount once
    // Look for patterns like: total * (1 - discount/100) at the end
    const hasCorrectPattern =
      // Should NOT have discount inside the item loop
      !cartContent.includes('discounted = itemTotal * (1 - cart.discount') &&
      // Should have discount applied after the loop
      (cartContent.includes('total * (1 - cart.discount') ||
        cartContent.includes('total * (100 - cart.discount') ||
        cartContent.includes('total * ((100 - cart.discount') ||
        // or subtotal pattern
        cartContent.includes('subtotal * (1 - cart.discount') ||
        cartContent.includes('subtotal * (100 - cart.discount'));

    const checks = [
      {
        name: 'read_test',
        pass: run.toolCalls.some(
          (tc) => tc.toolName === 'read_file' && /cart\.test/i.test(String(tc.arguments.path)),
        ),
        detail: 'Model should read the test file to understand expected behavior',
      },
      {
        name: 'read_implementation',
        pass: run.toolCalls.some(
          (tc) => tc.toolName === 'read_file' && /src\/cart/i.test(String(tc.arguments.path)),
        ),
        detail: 'Model should read the implementation file',
      },
      {
        name: 'used_edit_file',
        pass: run.toolCalls.some((tc) => tc.toolName === 'edit_file' && !tc.isError),
        detail: 'Model should edit the implementation',
      },
      {
        name: 'correct_fix',
        pass: hasCorrectPattern,
        detail: 'Discount should be applied to the total, not per-item',
      },
      {
        name: 'completed',
        pass: run.stopReason === 'complete',
        detail: 'Model should complete the task',
      },
    ];

    const allPassed = checks.every((c) => c.pass);
    return {
      pass: allPassed,
      reason: allPassed
        ? 'Successfully fixed calculateTotal to apply discount to the total'
        : `Failed checks: ${checks.filter((c) => !c.pass).map((c) => c.name).join(', ')}`,
      checks,
    };
  },
};

export default scenario;
