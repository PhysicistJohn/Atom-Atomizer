import type { Plugin, ResolvedConfig } from 'vite';
import {
  CONTENT_SECURITY_POLICY_HEADER,
  developmentRendererCsp,
  resolveReactRefreshPreamble,
  transformDevelopmentRendererCsp,
} from './renderer-csp.js';
import type { RendererTrust } from './renderer-trust.js';

/**
 * Installs an HTTP CSP before Vite writes any response bytes, then mirrors the
 * same policy in HTML. The script hash is derived from the exact preamble that
 * the installed React plugin emits for Vite's resolved development base.
 */
export function createDevelopmentRendererCspPlugin(
  trust: RendererTrust,
  reactRefreshPreambleTemplate: string,
): Plugin {
  let policy: string | undefined;

  const requirePolicy = (): string => {
    if (!policy) throw new Error('Development renderer CSP was used before Vite resolved its configuration');
    return policy;
  };

  return {
    name: 'atomizer-exact-development-csp',
    apply: 'serve',
    configResolved(config: ResolvedConfig) {
      const preamble = resolveReactRefreshPreamble(reactRefreshPreambleTemplate, config.base);
      policy = developmentRendererCsp(trust, preamble);
    },
    configureServer(server) {
      const resolvedPolicy = requirePolicy();
      server.middlewares.use((_request, response, next) => {
        response.setHeader(CONTENT_SECURITY_POLICY_HEADER, resolvedPolicy);
        next();
      });
    },
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        return transformDevelopmentRendererCsp(html, requirePolicy());
      },
    },
  };
}
