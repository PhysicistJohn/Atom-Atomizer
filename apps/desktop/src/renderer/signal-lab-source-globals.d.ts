/**
 * The renderer source-bundles the sibling SignalLab catalog, and one frozen
 * module in that catalog (`src/lte-etm1-provider.ts`) reads `process.platform`
 * and `process.arch` to decide whether its float64 libm pin is byte-assertable
 * on the current host. The renderer program deliberately types only
 * `vite/client`, so that read has no declaration and the shared source cannot
 * compile.
 *
 * Declaring the two properties that module actually reads keeps the renderer
 * from importing the whole Node type surface, which would let genuinely
 * renderer-side code compile calls to `fs`, `path`, or `process.exit` that do
 * not exist behind Electron's context isolation. Nothing in `src/renderer`
 * reads `process` itself, and nothing should start.
 */
declare const process: {
  readonly platform: string;
  readonly arch: string;
};
