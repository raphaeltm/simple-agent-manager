/**
 * Sanitizes a URL by only allowing http: and https: protocols.
 * Returns '#' for any other protocol (e.g., javascript:, data:) to prevent XSS.
 */
export function sanitizeUrl(url: string): string {
  if (!url) return '#';
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return url;
    }
    return '#';
  } catch {
    return '#';
  }
}
