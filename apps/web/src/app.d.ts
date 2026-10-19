// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
  namespace App {
    interface Error {
      /** Quoted to support; never contains request data. */
      reference?: string;
    }
  }
}

export {};
