import type { Root } from 'react-dom/client';

const RETAINED_ROOT_PROPERTY = '__atomizerReactRoot' as const;

type RendererRootHost = HTMLElement & {
  [RETAINED_ROOT_PROPERTY]?: Root;
};

/**
 * Vite can invalidate the renderer entry module when an imported module is not
 * a React Fast Refresh boundary. Retain the React root on its DOM host so a hot
 * update renders through the existing root instead of creating a second root
 * for the same container.
 */
export function retainRendererRoot(
  host: HTMLElement,
  create: (container: HTMLElement) => Root,
): Root {
  const retainedHost = host as RendererRootHost;
  retainedHost[RETAINED_ROOT_PROPERTY] ??= create(host);
  return retainedHost[RETAINED_ROOT_PROPERTY];
}
