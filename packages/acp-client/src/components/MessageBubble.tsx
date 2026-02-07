import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MessageBubbleProps {
  text: string;
  role: 'user' | 'agent';
  streaming?: boolean;
}

/**
 * Renders a single message bubble with markdown support.
 * Agent messages are left-aligned, user messages are right-aligned.
 */
export function MessageBubble({ text, role, streaming }: MessageBubbleProps) {
  const isUser = role === 'user';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}>
      <div
        className={`max-w-[80%] rounded-lg px-4 py-3 ${
          isUser
            ? 'bg-blue-600 text-white'
            : 'bg-white border border-gray-200 text-gray-900'
        }`}
      >
        <div className="prose prose-sm max-w-none overflow-hidden">
          <Markdown
            remarkPlugins={[remarkGfm]}
            components={{
              code: ({ className, children, ...props }) => {
                const match = /language-(\w+)/.exec(className || '');
                const isInline = !match && !className;
                if (isInline) {
                  return (
                    <code
                      className={`${isUser ? 'bg-blue-500 text-blue-50' : 'bg-gray-100 text-gray-800'} px-1 py-0.5 rounded text-xs font-mono`}
                      {...props}
                    >
                      {children}
                    </code>
                  );
                }
                return (
                  <pre className="bg-gray-900 text-gray-100 p-3 rounded-md overflow-x-auto text-xs">
                    <code className={className} {...props}>
                      {children}
                    </code>
                  </pre>
                );
              },
              a: ({ href, children }) => (
                <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-400 underline">
                  {children}
                </a>
              ),
            }}
          >
            {text}
          </Markdown>
        </div>
        {streaming && (
          <span className="inline-block mt-1 text-xs opacity-60 animate-pulse">...</span>
        )}
      </div>
    </div>
  );
}
