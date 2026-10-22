/** A value loaded from the api, with the three states every screen shows: loading, ready, failed. */
import { ApiError } from './api.ts';

export class Resource<T> {
  status = $state<'loading' | 'ready' | 'error'>('loading');
  data = $state<T | undefined>(undefined);
  error = $state<ApiError | undefined>(undefined);
  readonly #load: () => Promise<T>;

  constructor(load: () => Promise<T>) {
    this.#load = load;
  }

  async refresh(options: { readonly quiet?: boolean } = {}): Promise<void> {
    if (options.quiet !== true) this.status = 'loading';
    try {
      this.data = await this.#load();
      this.error = undefined;
      this.status = 'ready';
    } catch (error) {
      this.error = error instanceof ApiError ? error : new ApiError(0, 'unexpected');
      this.status = 'error';
    }
  }
}
