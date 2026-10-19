// Every test renders with the real tokens, so axe's colour checks see what users see.
import '../src/tokens.css';

declare module 'vitest/browser' {
  interface BrowserCommands {
    reducedMotion: (reduce: boolean) => Promise<void>;
  }
}
