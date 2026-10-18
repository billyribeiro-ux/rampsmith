/**
 * Toast state (PLAN §16). Information and success toasts leave after `timeoutMs`, paused while
 * the pointer or focus is on them; errors stay until dismissed.
 */
export type Tone = 'info' | 'success' | 'error';

export interface Toast {
  readonly id: number;
  readonly message: string;
  readonly tone: Tone;
}

export interface ShowOptions {
  readonly tone?: Tone;
  /** For info and success only. Default 6 seconds. */
  readonly timeoutMs?: number;
}

interface Timer {
  readonly id: number;
  readonly timeoutMs: number;
  handle: ReturnType<typeof setTimeout> | undefined;
}

export class Toasts {
  toasts: Toast[] = $state([]);
  #next = 1;
  // Countdowns are bookkeeping, not rendered state.
  #timers: Timer[] = [];
  #paused = false;

  show(message: string, options: ShowOptions = {}): number {
    const id = this.#next;
    this.#next += 1;
    const tone = options.tone ?? 'info';
    this.toasts.push({ id, message, tone });
    if (tone !== 'error') {
      const timer: Timer = { id, timeoutMs: options.timeoutMs ?? 6_000, handle: undefined };
      this.#timers.push(timer);
      if (!this.#paused) this.#arm(timer);
    }
    return id;
  }

  dismiss(id: number): void {
    for (const timer of this.#timers) {
      if (timer.id === id && timer.handle !== undefined) clearTimeout(timer.handle);
    }
    this.#timers = this.#timers.filter((t) => t.id !== id);
    this.toasts = this.toasts.filter((t) => t.id !== id);
  }

  /** Stops every countdown while someone is reading or interacting with the toasts. */
  pause(): void {
    this.#paused = true;
    for (const timer of this.#timers) {
      if (timer.handle !== undefined) clearTimeout(timer.handle);
      timer.handle = undefined;
    }
  }

  /** Restarts each countdown from its full length. */
  resume(): void {
    this.#paused = false;
    for (const timer of this.#timers) this.#arm(timer);
  }

  #arm(timer: Timer): void {
    timer.handle = setTimeout(() => {
      this.dismiss(timer.id);
    }, timer.timeoutMs);
  }
}
