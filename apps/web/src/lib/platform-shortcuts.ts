interface NavigatorWithUserAgentData extends Navigator {
  userAgentData?: {
    platform?: string;
  };
}

const APPLE_PLATFORM_PATTERN = /mac|iphone|ipad|ipod/i;

export function isApplePlatform(platform: string | undefined): boolean {
  return APPLE_PLATFORM_PATTERN.test(platform ?? '');
}

function getNavigatorPlatform(): string {
  if (typeof navigator === 'undefined') return '';

  const platformNavigator = navigator as NavigatorWithUserAgentData;
  return platformNavigator.userAgentData?.platform ?? platformNavigator.platform ?? '';
}

export function getSendShortcutLabel(
  platform = getNavigatorPlatform()
): 'Cmd+Enter' | 'Ctrl+Enter' {
  return isApplePlatform(platform) ? 'Cmd+Enter' : 'Ctrl+Enter';
}

export function getSendShortcutAriaKey(
  platform = getNavigatorPlatform()
): 'Meta+Enter' | 'Control+Enter' {
  return isApplePlatform(platform) ? 'Meta+Enter' : 'Control+Enter';
}

export function getSendShortcutHint(platform = getNavigatorPlatform()): string {
  return `Press ${getSendShortcutLabel(platform)} to send, Enter for new line`;
}

export function getSendButtonTitle(platform = getNavigatorPlatform()): string {
  return `Send message (${getSendShortcutLabel(platform)})`;
}
