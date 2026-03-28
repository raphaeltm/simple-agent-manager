import { type CSSProperties, type FC } from 'react';

/**
 * Pure rendering component for unified diff output.
 * Extracted from GitDiffView for reuse in both workspace and chat views.
 */
export const DiffRenderer: FC<{ diff: string }> = ({ diff }) => {
  const lines = diff.split('\n');

  return (
    <div style={{ fontFamily: 'monospace', fontSize: '0.8125rem' }}>
      {lines.map((line, idx) => (
        <div key={idx} style={diffLineStyle(line)}>
          {line}
        </div>
      ))}
    </div>
  );
};

function diffLineStyle(line: string): CSSProperties {
  const base: CSSProperties = {
    padding: '1px 12px',
    whiteSpace: 'pre',
    minHeight: '1.4em',
    lineHeight: '1.4',
  };

  if (line.startsWith('+') && !line.startsWith('+++')) {
    return {
      ...base,
      backgroundColor: 'var(--sam-color-success-tint)',
      color: 'var(--sam-color-tn-green)',
    };
  }
  if (line.startsWith('-') && !line.startsWith('---')) {
    return {
      ...base,
      backgroundColor: 'var(--sam-color-danger-tint)',
      color: 'var(--sam-color-tn-red)',
    };
  }
  if (line.startsWith('@@')) {
    return {
      ...base,
      backgroundColor: 'var(--sam-color-info-tint)',
      color: 'var(--sam-color-tn-blue)',
    };
  }
  if (
    line.startsWith('diff ') ||
    line.startsWith('index ') ||
    line.startsWith('---') ||
    line.startsWith('+++')
  ) {
    return {
      ...base,
      color: 'var(--sam-color-fg-muted)',
      fontWeight: 600,
    };
  }

  return {
    ...base,
    color: 'var(--sam-color-fg-muted)',
  };
}

/**
 * Parse a unified diff to extract which line numbers in the new file are additions.
 * Returns a Set of 1-based line numbers.
 */
export function parseDiffAddedLines(diff: string): Set<number> {
  const added = new Set<number>();
  if (!diff) return added;

  let currentLine = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) {
      const match = line.match(/\+(\d+)/);
      if (match?.[1]) {
        currentLine = parseInt(match[1], 10);
      }
      continue;
    }
    if (currentLine === 0) continue;

    if (line.startsWith('+') && !line.startsWith('+++')) {
      added.add(currentLine);
      currentLine++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      // Removed lines don't advance the new-file line counter
    } else {
      currentLine++;
    }
  }

  return added;
}
