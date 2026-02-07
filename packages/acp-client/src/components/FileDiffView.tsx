interface FileDiffViewProps {
  diff: string;
  filePath?: string;
}

/**
 * Renders a unified diff with syntax highlighting.
 * Additions in green, removals in red, context in gray.
 */
export function FileDiffView({ diff, filePath }: FileDiffViewProps) {
  if (!diff) return null;

  const lines = diff.split('\n');

  return (
    <div className="font-mono text-xs overflow-x-auto">
      {filePath && (
        <div className="px-3 py-1.5 bg-gray-100 border-b border-gray-200 text-gray-600 font-medium">
          {filePath}
        </div>
      )}
      <div className="bg-gray-50">
        {lines.map((line, idx) => {
          let bgClass = '';
          let textClass = 'text-gray-600';

          if (line.startsWith('+') && !line.startsWith('+++')) {
            bgClass = 'bg-green-50';
            textClass = 'text-green-800';
          } else if (line.startsWith('-') && !line.startsWith('---')) {
            bgClass = 'bg-red-50';
            textClass = 'text-red-800';
          } else if (line.startsWith('@@')) {
            bgClass = 'bg-blue-50';
            textClass = 'text-blue-600';
          }

          return (
            <div key={idx} className={`px-3 py-0.5 ${bgClass} ${textClass} whitespace-pre`}>
              {line}
            </div>
          );
        })}
      </div>
    </div>
  );
}
