import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Textarea } from '../src/components/Textarea';

describe('Textarea', () => {
  it('renders with the default row count and forwards changes', () => {
    const onChange = vi.fn();

    render(<Textarea aria-label="Comment body" onChange={onChange} />);

    const textarea = screen.getByRole('textbox', { name: 'Comment body' });
    expect(textarea).toHaveAttribute('rows', '3');

    fireEvent.change(textarea, { target: { value: 'Looks good' } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('accepts custom rows and class names', () => {
    render(<Textarea aria-label="Reply body" rows={6} className="custom-textarea" />);

    const textarea = screen.getByRole('textbox', { name: 'Reply body' });
    expect(textarea).toHaveAttribute('rows', '6');
    expect(textarea).toHaveClass('custom-textarea');
  });
});
