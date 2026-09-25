import type { PlacementResolutionErrorCode } from './placement-resolver-types';

export class PlacementResolutionError extends Error {
  readonly code: PlacementResolutionErrorCode;
  readonly validValues: readonly string[];

  constructor(code: PlacementResolutionErrorCode, message: string, validValues: readonly string[]) {
    super(message);
    this.name = 'PlacementResolutionError';
    this.code = code;
    this.validValues = validValues;
  }
}
