import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FileDiffView } from '../../../src/components/FileDiffView';

function renderDiff(diff: string, filePath?: string) {
  return render(<FileDiffView diff={diff} filePath={filePath} />);
}

describe('FileDiffView', () => {
  it('returns null for empty diff', () => {
    const { container } = renderDiff('');
    expect(container.innerHTML).toBe('');
  });

  it('renders file path header when provided', () => {
    renderDiff('+added line', 'src/index.ts');
    expect(screen.getByText('src/index.ts')).toBeTruthy();
  });

  it('does not render file path header when omitted', () => {
    const { container } = renderDiff('+added line');
    expect(container.querySelector('[title]')).toBeNull();
  });

  it('classifies addition lines with green styling', () => {
    const { container } = renderDiff('+const x = 1;');
    const line = container.querySelector('.bg-green-50');
    expect(line).toBeTruthy();
    expect(line?.textContent).toBe('+const x = 1;');
  });

  it('classifies removal lines with red styling', () => {
    const { container } = renderDiff('-const x = 1;');
    const line = container.querySelector('.bg-red-50');
    expect(line).toBeTruthy();
    expect(line?.textContent).toBe('-const x = 1;');
  });

  it('classifies hunk headers with blue styling', () => {
    const { container } = renderDiff('@@ -1,3 +1,4 @@');
    const line = container.querySelector('.bg-blue-50');
    expect(line).toBeTruthy();
  });

  it('does not classify +++ as an addition', () => {
    const { container } = renderDiff('+++  b/src/index.ts');
    expect(container.querySelector('.bg-green-50')).toBeNull();
  });

  it('does not classify --- as a removal', () => {
    const { container } = renderDiff('---  a/src/index.ts');
    expect(container.querySelector('.bg-red-50')).toBeNull();
  });

  it('renders context lines as neutral', () => {
    const { container } = renderDiff('  unchanged line');
    const lines = container.querySelectorAll('.px-3');
    expect(lines.length).toBe(1);
    expect(lines[0].classList.contains('bg-green-50')).toBe(false);
    expect(lines[0].classList.contains('bg-red-50')).toBe(false);
  });

  it('renders multiple lines from a unified diff', () => {
    const diff = `@@ -1,3 +1,4 @@
 context
-removed
+added
+new line`;
    const { container } = renderDiff(diff);
    expect(container.querySelector('.bg-blue-50')).toBeTruthy();
    expect(container.querySelector('.bg-red-50')).toBeTruthy();
    expect(container.querySelectorAll('.bg-green-50').length).toBe(2);
  });

  it('uses monospace font and horizontal scroll', () => {
    const { container } = renderDiff('+line');
    const wrapper = container.firstElementChild;
    expect(wrapper?.classList.contains('font-mono')).toBe(true);
    expect(wrapper?.classList.contains('overflow-x-auto')).toBe(true);
  });

  it('truncates long file paths with title attribute', () => {
    const longPath = 'packages/very/deep/nested/path/to/some/component/file.tsx';
    renderDiff('+line', longPath);
    const header = screen.getByTitle(longPath);
    expect(header).toBeTruthy();
    expect(header.classList.contains('truncate')).toBe(true);
  });
});
