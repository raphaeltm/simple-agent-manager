// =============================================================================
// API Error
// =============================================================================
export interface ApiError {
  error: string;
  message: string;
  details?: Record<string, unknown>;
}
