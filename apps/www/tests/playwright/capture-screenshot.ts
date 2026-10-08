/** Chromium's mobile compositor can reject a capture immediately after navigation.
 * Retry only that transient protocol error; a screenshot is still mandatory.
 */
export async function captureScreenshot<T>(capture: () => Promise<T>): Promise<T> {
  const maxAttempts = 3;
  for (let attempt = 1; ; attempt++) {
    try {
      return await capture();
    } catch (error) {
      if (
        attempt === maxAttempts ||
        !(error instanceof Error) ||
        !error.message.includes('Unable to capture screenshot')
      ) {
        throw error;
      }
    }
  }
}
