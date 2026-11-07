import { type ReactNode, useEffect, useState } from 'react';

/**
 * A lone video file in the browser's player, or `fallback` once the browser gives up on it
 * (unsupported codec, damaged file). Used by the library preview (an API URL) and the composer's
 * attachment preview (a local `blob:` URL).
 */
export function VideoViewer({
  src,
  filename,
  fallback,
}: {
  src: string;
  filename: string;
  fallback: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  // A new file is a new chance to play.
  useEffect(() => setFailed(false), [src]);
  if (failed) return <>{fallback}</>;
  return (
    <div className="flex h-full min-h-0 items-center justify-center">
      {/* No `crossOrigin`: like the image viewer's <img>, an API URL carries the session cookie,
          and the API answers byte ranges so the player can seek. */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- a lone uploaded video has no
          caption file to attach; there is no track to point at. */}
      <video
        src={src}
        controls
        playsInline
        preload="metadata"
        aria-label={`Video ${filename}`}
        data-testid="video-preview"
        className="block h-full w-full object-contain"
        onError={() => setFailed(true)}
      />
    </div>
  );
}
