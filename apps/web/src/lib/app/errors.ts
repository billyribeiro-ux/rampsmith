import { m } from '#lib/paraglide/messages.js';
import { ApiError } from './api.ts';

/** What to tell the merchant about a failed request; never the api's own wording. */
export function errorMessage(error: ApiError | undefined): string {
  switch (error?.code ?? 'unexpected') {
    case 'network':
      return m.app_error_network();
    case 'unauthenticated':
      return m.app_error_unauthenticated();
    case 'forbidden':
      return m.app_error_forbidden();
    case 'not_found':
      return m.app_error_not_found();
    case 'conflict':
      return m.app_error_conflict();
    case 'rate_limited':
      return m.app_error_rate_limited();
    case 'validation_failed':
      return m.app_error_validation();
    case 'unavailable':
      return m.app_error_unavailable();
    default:
      return m.app_error_unexpected();
  }
}

export function asApiError(error: unknown): ApiError {
  return error instanceof ApiError ? error : new ApiError(0, 'unexpected');
}
