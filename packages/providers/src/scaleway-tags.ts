export function labelsToScalewayTags(labels: Record<string, string>): string[] {
  return Object.entries(labels).map(([key, value]) => `${key}=${value}`);
}

export function scalewayTagsToLabels(tags: string[]): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const tag of tags) {
    const eqIndex = tag.indexOf('=');
    if (eqIndex > 0) {
      labels[tag.slice(0, eqIndex)] = tag.slice(eqIndex + 1);
    }
  }
  return labels;
}
