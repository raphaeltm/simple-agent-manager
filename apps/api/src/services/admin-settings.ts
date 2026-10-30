/** Runtime admin settings: resolution and atomic mutations share one invalidation boundary. */
export { adminSettingCacheMs, __resetAdminSettingsCacheForTest, invalidateAdminSettings, resolveAdminSettingDetailsMany, resolveAdminSettingDetails, resolveAdminSetting, readAdminSettings, type AdminSettingsView } from './admin-settings-resolution';
export { commitAdminSettingsStatements, validateAdminSettingsChanges, updateAdminSettings } from './admin-settings-mutations';
