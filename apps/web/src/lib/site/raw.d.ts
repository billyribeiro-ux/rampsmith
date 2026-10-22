// Vite's `?raw` suffix imports a file's text (used for the draft documents in docs/).
declare module '*.md?raw' {
  const content: string;
  export default content;
}
