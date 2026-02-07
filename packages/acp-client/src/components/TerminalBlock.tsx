interface TerminalBlockProps {
  command?: string;
  output: string;
}

/**
 * Renders shell command output in a terminal-style block.
 * Shows command header and scrollable output area.
 */
export function TerminalBlock({ command, output }: TerminalBlockProps) {
  return (
    <div className="font-mono text-xs">
      {command && (
        <div className="px-3 py-1.5 bg-gray-800 text-gray-300 border-b border-gray-700 flex items-center space-x-1">
          <span className="text-green-400">$</span>
          <span>{command}</span>
        </div>
      )}
      <div className="bg-gray-900 text-gray-200 p-3 max-h-60 overflow-auto whitespace-pre-wrap">
        {output || <span className="text-gray-500">(no output)</span>}
      </div>
    </div>
  );
}
