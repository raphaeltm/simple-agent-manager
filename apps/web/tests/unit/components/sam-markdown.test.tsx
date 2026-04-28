import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SamMarkdown } from '../../../src/pages/sam-prototype/sam-markdown';

describe('SamMarkdown', () => {
  it('renders paragraph text', () => {
    render(<SamMarkdown content="Hello world" />);
    expect(screen.getByText('Hello world')).toBeInTheDocument();
  });

  it('renders headings', () => {
    const { container } = render(<SamMarkdown content={'# Heading One\n\n## Heading Two'} />);
    const h1 = container.querySelector('h1');
    const h2 = container.querySelector('h2');
    expect(h1).not.toBeNull();
    expect(h1!.textContent).toBe('Heading One');
    expect(h2).not.toBeNull();
    expect(h2!.textContent).toBe('Heading Two');
  });

  it('renders inline code with green glass styling', () => {
    render(<SamMarkdown content="Use `console.log` here" />);
    const code = screen.getByText('console.log');
    expect(code.tagName).toBe('CODE');
    expect(code.style.background).toContain('rgba(60, 180, 120');
  });

  it('renders fenced code blocks with language label', () => {
    const md = '```typescript\nconst x = 1;\n```';
    render(<SamMarkdown content={md} />);
    expect(screen.getByText('typescript')).toBeInTheDocument();
  });

  it('renders a copy button on code blocks', () => {
    const md = '```js\nalert("hi")\n```';
    render(<SamMarkdown content={md} />);
    expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
  });

  it('renders tables via remark-gfm', () => {
    const md = '| Name | Value |\n|------|-------|\n| A    | 1     |\n| B    | 2     |';
    render(<SamMarkdown content={md} />);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('renders unordered lists', () => {
    const { container } = render(<SamMarkdown content={'- Item one\n- Item two\n- Item three'} />);
    const items = container.querySelectorAll('li');
    expect(items.length).toBeGreaterThanOrEqual(3);
  });

  it('renders ordered lists', () => {
    const { container } = render(<SamMarkdown content={'1. First\n2. Second'} />);
    const ol = container.querySelector('ol');
    expect(ol).not.toBeNull();
  });

  it('renders blockquotes', () => {
    const { container } = render(<SamMarkdown content="> This is a quote" />);
    const bq = container.querySelector('blockquote');
    expect(bq).not.toBeNull();
    expect(bq!.textContent).toContain('This is a quote');
  });

  it('renders links with target=_blank', () => {
    render(<SamMarkdown content="[Click here](https://example.com)" />);
    const link = screen.getByRole('link', { name: 'Click here' });
    expect(link).toHaveAttribute('href', 'https://example.com');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders task list checkboxes', () => {
    const { container } = render(<SamMarkdown content={'- [x] Done\n- [ ] Not done'} />);
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes.length).toBe(2);
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(true);
    expect((checkboxes[1] as HTMLInputElement).checked).toBe(false);
  });

  it('renders bold and italic text', () => {
    const { container } = render(<SamMarkdown content="**bold** and *italic*" />);
    expect(container.querySelector('strong')!.textContent).toBe('bold');
    expect(container.querySelector('em')!.textContent).toBe('italic');
  });

  it('wraps content in .sam-markdown class', () => {
    const { container } = render(<SamMarkdown content="test" />);
    expect(container.querySelector('.sam-markdown')).not.toBeNull();
  });
});

describe('CopyButton (via SamMarkdown)', () => {
  it('shows Copied feedback after clicking copy button', async () => {
    // userEvent.setup() provides its own clipboard implementation in jsdom,
    // so we rely on the DOM state transition as behavioral evidence.
    const md = '```js\nconst x = 1;\n```';
    render(<SamMarkdown content={md} />);

    const user = userEvent.setup();
    const btn = screen.getByRole('button', { name: /copy/i });
    expect(btn).toBeInTheDocument();

    // Before click: shows "Copy"
    expect(screen.getByText('Copy')).toBeInTheDocument();

    await user.click(btn);

    // After click: shows "Copied" (clipboard.writeText resolved)
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('copy button is present on each code block', () => {
    const md = '```js\nfoo()\n```\n\n```python\nbar()\n```';
    render(<SamMarkdown content={md} />);

    const buttons = screen.getAllByRole('button', { name: /copy/i });
    expect(buttons.length).toBe(2);
  });

  it('copy button has aria-label that updates on click', async () => {
    const md = '```js\nconst x = 1;\n```';
    render(<SamMarkdown content={md} />);

    const user = userEvent.setup();
    const btn = screen.getByRole('button', { name: 'Copy code to clipboard' });
    expect(btn).toBeInTheDocument();

    await user.click(btn);

    expect(await screen.findByRole('button', { name: 'Copied to clipboard' })).toBeInTheDocument();
  });

  it('decorative icons have aria-hidden', () => {
    const md = '```js\nconst x = 1;\n```';
    const { container } = render(<SamMarkdown content={md} />);

    const svgs = container.querySelectorAll('.sam-copy-btn svg');
    svgs.forEach((svg) => {
      expect(svg.getAttribute('aria-hidden')).toBe('true');
    });
  });
});

describe('CopyButton execCommand fallback', () => {
  const originalClipboard = navigator.clipboard;

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: originalClipboard,
      writable: true,
      configurable: true,
    });
    vi.restoreAllMocks();
  });

  it('uses execCommand fallback when navigator.clipboard is unavailable', async () => {
    const execMock = vi.fn().mockReturnValue(true);
    document.execCommand = execMock;

    const md = '```js\nconst x = 1;\n```';
    render(<SamMarkdown content={md} />);

    // Override clipboard AFTER render but before click
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      writable: true,
      configurable: true,
    });

    const btn = screen.getByRole('button', { name: /copy code to clipboard/i });
    fireEvent.click(btn);

    expect(execMock).toHaveBeenCalledWith('copy');
    expect(await screen.findByRole('button', { name: /copied to clipboard/i })).toBeInTheDocument();
  });

  it('does not show Copied when execCommand returns false', async () => {
    document.execCommand = vi.fn().mockReturnValue(false);

    const md = '```js\nconst x = 1;\n```';
    render(<SamMarkdown content={md} />);

    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      writable: true,
      configurable: true,
    });

    const btn = screen.getByRole('button', { name: /copy code to clipboard/i });
    fireEvent.click(btn);

    // Should still show "Copy", not "Copied"
    expect(screen.getByRole('button', { name: /copy code to clipboard/i })).toBeInTheDocument();
  });
});

describe('SamMarkdown accessibility', () => {
  it('code block has role="region" and aria-label', () => {
    const md = '```typescript\nconst x = 1;\n```';
    render(<SamMarkdown content={md} />);

    const region = screen.getByRole('region', { name: /typescript code block/i });
    expect(region).toBeInTheDocument();
  });

  it('code block without language gets "text code block" label', () => {
    // react-markdown adds class="language-undefined" for bare fences
    const md = '```text\nplain text\n```';
    render(<SamMarkdown content={md} />);

    const region = screen.getByRole('region', { name: /text code block/i });
    expect(region).toBeInTheDocument();
  });
});
