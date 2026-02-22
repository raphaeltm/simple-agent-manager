import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ButtonGroup } from '../src/components/ButtonGroup';
import { Button } from '../src/components/Button';

describe('ButtonGroup', () => {
  it('renders children in a group role container', () => {
    render(
      <ButtonGroup>
        <Button>First</Button>
        <Button>Second</Button>
      </ButtonGroup>,
    );
    expect(screen.getByRole('group')).toBeInTheDocument();
    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
  });

  it('applies correct border radius to first child', () => {
    render(
      <ButtonGroup>
        <Button>First</Button>
        <Button>Second</Button>
        <Button>Third</Button>
      </ButtonGroup>,
    );
    const first = screen.getByText('First');
    expect(first.style.borderRadius).toBe('var(--sam-radius-sm) 0 0 var(--sam-radius-sm)');
  });

  it('applies correct border radius to last child', () => {
    render(
      <ButtonGroup>
        <Button>First</Button>
        <Button>Second</Button>
        <Button>Third</Button>
      </ButtonGroup>,
    );
    const last = screen.getByText('Third');
    expect(last.style.borderRadius).toBe('0 var(--sam-radius-sm) var(--sam-radius-sm) 0');
  });

  it('applies zero border radius to middle children', () => {
    render(
      <ButtonGroup>
        <Button>First</Button>
        <Button>Second</Button>
        <Button>Third</Button>
      </ButtonGroup>,
    );
    const middle = screen.getByText('Second');
    expect(middle.style.borderRadius).toBe('0');
  });

  it('applies full border radius when only one child', () => {
    render(
      <ButtonGroup>
        <Button>Only</Button>
      </ButtonGroup>,
    );
    const only = screen.getByText('Only');
    expect(only.style.borderRadius).toBe('var(--sam-radius-sm)');
  });

  it('collapses borders with negative margin on non-first children', () => {
    render(
      <ButtonGroup>
        <Button>First</Button>
        <Button>Second</Button>
      </ButtonGroup>,
    );
    const second = screen.getByText('Second');
    expect(second.style.marginLeft).toBe('-1px');
  });

  it('passes className to container', () => {
    const { container } = render(
      <ButtonGroup className="my-group">
        <Button>A</Button>
      </ButtonGroup>,
    );
    expect(container.querySelector('.my-group')).toBeInTheDocument();
  });
});
