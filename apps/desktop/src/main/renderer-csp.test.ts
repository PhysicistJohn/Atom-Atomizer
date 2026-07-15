import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONTENT_SECURITY_POLICY_HEADER,
  PACKAGED_RENDERER_CSP,
  developmentRendererCsp,
  inlineScriptCspHash,
  resolveReactRefreshPreamble,
  transformDevelopmentRendererCsp,
} from './renderer-csp.js';
import { developmentRendererTrust, validateDevelopmentServerUrl } from './renderer-trust.js';

describe('Atomizer renderer CSP', () => {
  const sourceHtml = readFileSync(fileURLToPath(new URL('../renderer/index.html', import.meta.url)), 'utf8');
  const developmentTrust = developmentRendererTrust(validateDevelopmentServerUrl('http://127.0.0.1:4173/path'));
  const preambleTemplate = 'import runtime from "__BASE__@react-refresh";\nruntime();';
  const preamble = 'import runtime from "/@react-refresh";\nruntime();';

  it('keeps the source and therefore packaged build free of development network origins', () => {
    expect(CONTENT_SECURITY_POLICY_HEADER).toBe('Content-Security-Policy');
    expect(sourceHtml).toContain(`content="${PACKAGED_RENDERER_CSP}"`);
    expect(sourceHtml).not.toMatch(/localhost|127\.0\.0\.1|ws:\/\//);
    expect(PACKAGED_RENDERER_CSP).not.toMatch(/localhost|127\.0\.0\.1|ws:\/\/|unsafe-eval/);
  });

  it('allows only the exact hashed React preamble and selected Vite WebSocket origin in development', () => {
    expect(resolveReactRefreshPreamble(preambleTemplate, '/')).toBe(preamble);
    const policy = developmentRendererCsp(developmentTrust, preamble);
    expect(policy).toBe(
      PACKAGED_RENDERER_CSP
        .replace("script-src 'self'", `script-src 'self' ${inlineScriptCspHash(preamble)}`)
        .replace("connect-src 'self'", "connect-src 'self' ws://127.0.0.1:4173"),
    );
    expect(policy).not.toMatch(/unsafe-inline[^;]*script|unsafe-eval|ws:\/\/localhost|wss:\/\/|https?:\/\/127\.0\.0\.1/);
    expect(transformDevelopmentRendererCsp(sourceHtml, policy)).toContain(`content="${policy}"`);
  });

  it('rejects ambiguous preamble templates, remote bases, and HTML without the packaged policy', () => {
    expect(() => resolveReactRefreshPreamble('no placeholder', '/')).toThrow(/exactly one/i);
    expect(() => resolveReactRefreshPreamble('__BASE____BASE__', '/')).toThrow(/exactly one/i);
    expect(() => resolveReactRefreshPreamble('__BASE__', 'https://remote.example/')).toThrow(/same-origin/i);
    expect(() => developmentRendererCsp({ mode: 'production', url: 'file:///app/index.html' }, preamble)).toThrow(/development renderer trust/i);
    expect(() => developmentRendererCsp({ mode: 'development', origin: 'http://remote.example:4173' }, preamble)).toThrow(/localhost|127\.0\.0\.1|\[::1\]/i);
    expect(() => transformDevelopmentRendererCsp('<html></html>', 'default-src \'none\'')).toThrow(/exact packaged CSP/i);
    expect(() => transformDevelopmentRendererCsp(sourceHtml, 'default-src \'none\'" onload="alert(1)')).toThrow(/represented safely/i);
  });

  it('sets the canonical dev URL on the concurrently parent so Vite and Electron cannot inherit different origins', () => {
    const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const command = packageJson.scripts?.dev ?? '';
    const parentAssignment = 'cross-env VITE_DEV_SERVER_URL=http://localhost:5173 concurrently';
    expect(command).toContain(parentAssignment);
    expect(command.match(/VITE_DEV_SERVER_URL=/g)).toHaveLength(1);
    expect(command.indexOf(parentAssignment)).toBeLessThan(command.indexOf('"vite"'));
    expect(command).not.toMatch(/concurrently.+cross-env VITE_DEV_SERVER_URL=/);
  });
});
