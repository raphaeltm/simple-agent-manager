interface ModeSelectorProps {
  /** Available modes from agent capabilities */
  modes: string[];
  /** Currently active mode */
  currentMode: string | null;
  /** Called when user selects a mode */
  onSelectMode: (mode: string) => void;
}

/**
 * Segmented control for switching agent operating modes.
 * Only renders if the agent reports available modes.
 */
export function ModeSelector({ modes, currentMode, onSelectMode }: ModeSelectorProps) {
  if (!modes || modes.length === 0) return null;

  return (
    <div className="flex items-center space-x-1">
      <span className="text-xs text-gray-500 mr-1">Mode:</span>
      <div className="flex rounded-md border border-gray-300 overflow-hidden">
        {modes.map((mode) => (
          <button
            key={mode}
            onClick={() => onSelectMode(mode)}
            className={`px-2.5 py-1 text-xs font-medium capitalize transition-colors ${
              mode === currentMode
                ? 'bg-blue-600 text-white'
                : 'bg-white text-gray-600 hover:bg-gray-50'
            }`}
          >
            {mode}
          </button>
        ))}
      </div>
    </div>
  );
}
