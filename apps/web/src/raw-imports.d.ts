/** Vite/vinext ?raw imports resolve to the file's exact text content. */
declare module '*?raw' {
  const text: string;
  export default text;
}
