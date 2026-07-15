import { createHash } from 'node:crypto';
import { validateDevelopmentServerUrl, type RendererTrust } from './renderer-trust.js';

export const CONTENT_SECURITY_POLICY_HEADER = 'Content-Security-Policy';
export const PACKAGED_RENDERER_CSP = "default-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'";

/**
 * Computes the CSP source expression for one exact inline script. Hashing the
 * React-refresh preamble avoids granting every inline script permission to run.
 */
export function inlineScriptCspHash(source: string): string {
  return `'sha256-${createHash('sha256').update(source, 'utf8').digest('base64')}'`;
}

/** Resolves the exact source emitted by @vitejs/plugin-react for this Vite base. */
export function resolveReactRefreshPreamble(template: string, base: string): string {
  const marker = '__BASE__';
  const markerIndex = template.indexOf(marker);
  if (markerIndex < 0 || template.indexOf(marker, markerIndex + marker.length) >= 0) {
    throw new Error('React refresh preamble must contain exactly one Vite base placeholder');
  }
  if (!base.startsWith('/') || base.startsWith('//')) {
    throw new Error('React refresh preamble requires a same-origin absolute Vite base');
  }
  return template.replace(marker, base);
}

/**
 * Development permits only the exact React-refresh preamble and exact selected
 * Vite WebSocket endpoint. Every other packaged directive remains unchanged.
 */
export function developmentRendererCsp(trust: RendererTrust, reactRefreshPreamble: string): string {
  if (trust.mode !== 'development') throw new Error('Development CSP requires development renderer trust');
  const origin = validateDevelopmentServerUrl(trust.origin);
  const websocketOrigin = `ws://${origin.host}`;
  const preambleHash = inlineScriptCspHash(reactRefreshPreamble);
  return PACKAGED_RENDERER_CSP
    .replace("script-src 'self'", `script-src 'self' ${preambleHash}`)
    .replace("connect-src 'self'", `connect-src 'self' ${websocketOrigin}`);
}

/** Mirrors the effective HTTP policy in the development document's meta CSP. */
export function transformDevelopmentRendererCsp(html: string, developmentCsp: string): string {
  if (!developmentCsp || /["<>\r\n]/.test(developmentCsp)) {
    throw new Error('Development CSP cannot be represented safely in the renderer meta element');
  }
  const productionDirective = `content="${PACKAGED_RENDERER_CSP}"`;
  if (!html.includes(productionDirective)) {
    throw new Error('Renderer HTML does not contain the exact packaged CSP');
  }
  return html.replace(productionDirective, `content="${developmentCsp}"`);
}
