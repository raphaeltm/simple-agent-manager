import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RawFallbackView } from './RawFallbackView';
import type { RawFallback } from '../hooks/useAcpMessages';

function makeRawFallback(data: unknown = { foo: 'bar' }): RawFallback {
  return {
    kind: 'raw_fallback',
    id: 'fallback-1',
    timestamp: Date.now(),
    data,
  };
}

describe('RawFallbackView', () => {
  it('renders the fallback label', () => {
    render(<RawFallbackView item={makeRawFallback()} />);
    expect(screen.getByText('Rich rendering unavailable')).toBeTruthy();
  });

  it('renders data as JSON', () => {
    render(<RawFallbackView item={makeRawFallback({ hello: 'world' })} />);
    const pre = screen.getByText(/"hello": "world"/);
    expect(pre).toBeTruthy();
  });

  it('renders null data gracefully', () => {
    render(<RawFallbackView item={makeRawFallback(null)} />);
    expect(screen.getByText('null')).toBeTruthy();
  });

  it('renders complex nested data', () => {
    const data = { nested: { key: 'value', arr: [1, 2, 3] } };
    render(<RawFallbackView item={makeRawFallback(data)} />);
    expect(screen.getByText(/"key": "value"/)).toBeTruthy();
  });
});
