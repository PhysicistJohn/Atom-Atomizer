import { describe, expect, it } from 'vitest';
import {
  assertTrustedRendererEvent,
  developmentRendererTrust,
  isTrustedMediaPermission,
  isTrustedRendererEvent,
  isTrustedRendererSecurityOrigin,
  isTrustedRendererUrl,
  productionRendererTrust,
  selectDevelopmentServerUrl,
  validateDevelopmentServerUrl,
} from './renderer-trust.js';

describe('Atomizer renderer trust', () => {
  it('admits only explicit unauthenticated loopback HTTP development ports', () => {
    expect(validateDevelopmentServerUrl('http://localhost:5173').origin).toBe('http://localhost:5173');
    expect(validateDevelopmentServerUrl('http://127.0.0.1:4173/path').origin).toBe('http://127.0.0.1:4173');
    expect(validateDevelopmentServerUrl('http://[::1]:5173').origin).toBe('http://[::1]:5173');
    for (const value of [
      '', 'not a url', ' http://localhost:5173', 'http://localhost', 'https://localhost:5173',
      'http://example.com:5173', 'http://localhost.example:5173', 'http://127.0.0.2:5173',
      'http://user@localhost:5173', 'file:///tmp/index.html', 'ws://localhost:5173',
    ]) {
      expect(() => validateDevelopmentServerUrl(value)).toThrow(/VITE_DEV_SERVER_URL/);
    }
  });

  it('never parses or honors a development override in a packaged app', () => {
    expect(selectDevelopmentServerUrl('http://localhost:5173', true)).toBeUndefined();
    expect(selectDevelopmentServerUrl('https://attacker.example/renderer', true)).toBeUndefined();
    expect(selectDevelopmentServerUrl('malformed % url', true)).toBeUndefined();
    expect(selectDevelopmentServerUrl(undefined, true)).toBeUndefined();
    expect(selectDevelopmentServerUrl('http://localhost:5173', false)?.origin).toBe('http://localhost:5173');
  });

  it('requires the exact packaged file URL or exact development origin and port', () => {
    const production = productionRendererTrust('/Applications/Atomizer.app/Contents/Resources/renderer/index.html');
    const development = developmentRendererTrust(validateDevelopmentServerUrl('http://localhost:5173/app'));
    expect(isTrustedRendererUrl(production.url, production)).toBe(true);
    expect(isTrustedRendererUrl(`${production.url}?forged=1`, production)).toBe(false);
    expect(isTrustedRendererUrl('file:///tmp/index.html', production)).toBe(false);
    expect(isTrustedRendererUrl('http://localhost:5173/', development)).toBe(true);
    expect(isTrustedRendererUrl('http://localhost:5173/route?q=1#fragment', development)).toBe(true);
    expect(isTrustedRendererUrl('http://localhost:5174/', development)).toBe(false);
    expect(isTrustedRendererUrl('http://127.0.0.1:5173/', development)).toBe(false);
    expect(isTrustedRendererUrl('http://localhost:5173.evil.example/', development)).toBe(false);
    expect(isTrustedRendererUrl('blob:http://localhost:5173/80d8e08a', development)).toBe(false);
    expect(isTrustedRendererUrl('malformed % url', development)).toBe(false);
    expect(isTrustedRendererUrl('http://localhost:5173/', undefined)).toBe(false);
  });

  it('requires both expected WebContents identity and its exact main frame', () => {
    const trust = developmentRendererTrust(validateDevelopmentServerUrl('http://localhost:5173'));
    const mainFrame = { url: 'http://localhost:5173/analyzer' };
    const contents = { mainFrame };
    const trusted = { sender: contents, senderFrame: mainFrame };
    expect(isTrustedRendererEvent(trusted, contents, trust)).toBe(true);
    expect(() => assertTrustedRendererEvent(trusted, contents, trust)).not.toThrow();

    const cases = [
      { sender: { mainFrame }, senderFrame: mainFrame },
      { sender: contents, senderFrame: { url: mainFrame.url } },
      { sender: contents, senderFrame: { url: 'http://attacker.example/' } },
      { sender: contents, senderFrame: { url: 'malformed % url' } },
      {},
      null,
    ];
    for (const event of cases) {
      expect(isTrustedRendererEvent(event, contents, trust)).toBe(false);
      expect(() => assertTrustedRendererEvent(event, contents, trust)).toThrow(/untrusted renderer/i);
    }
    expect(isTrustedRendererEvent(trusted, { mainFrame }, trust)).toBe(false);
    expect(isTrustedRendererEvent(trusted, contents, undefined)).toBe(false);
  });

  it('fails closed for hostile event accessors', () => {
    const trust = developmentRendererTrust(validateDevelopmentServerUrl('http://localhost:5173'));
    const mainFrame = { url: 'http://localhost:5173' };
    const contents = { mainFrame };
    const event = Object.defineProperty({}, 'sender', { get() { throw new Error('hostile'); } });
    expect(isTrustedRendererEvent(event, contents, trust)).toBe(false);
  });
});

describe('Atomizer media permission trust', () => {
  it('admits only the selected development main frame and exact origin', () => {
    const trust = developmentRendererTrust(validateDevelopmentServerUrl('http://localhost:5173'));
    const contents = { mainFrame: { url: 'http://localhost:5173/voice' } };
    const details = { isMainFrame: true, requestingUrl: 'http://localhost:5173/voice', securityOrigin: 'http://localhost:5173' };
    expect(isTrustedMediaPermission(contents, 'media', details, 'http://localhost:5173', contents, trust)).toBe(true);
    expect(isTrustedMediaPermission(contents, 'geolocation', details, 'http://localhost:5173', contents, trust)).toBe(false);
    expect(isTrustedMediaPermission(contents, 'media', { ...details, isMainFrame: false }, 'http://localhost:5173', contents, trust)).toBe(false);
    expect(isTrustedMediaPermission(contents, 'media', { ...details, requestingUrl: 'http://localhost:5174/' }, 'http://localhost:5173', contents, trust)).toBe(false);
    expect(isTrustedMediaPermission(contents, 'media', details, 'http://localhost:5174', contents, trust)).toBe(false);
    expect(isTrustedMediaPermission(contents, 'media', details, 'http://localhost:5173.evil.example', contents, trust)).toBe(false);
    expect(isTrustedMediaPermission({ mainFrame: contents.mainFrame }, 'media', details, 'http://localhost:5173', contents, trust)).toBe(false);
    expect(isTrustedMediaPermission(contents, 'media', { ...details, requestingUrl: 'malformed % url' }, 'http://localhost:5173', contents, trust)).toBe(false);
  });

  it('admits only the exact packaged app file main frame', () => {
    const trust = productionRendererTrust('/Applications/Atomizer.app/Contents/Resources/renderer/index.html');
    const contents = { mainFrame: { url: trust.url } };
    const details = { isMainFrame: true, requestingUrl: trust.url, securityOrigin: 'file://' };
    expect(isTrustedMediaPermission(contents, 'media', details, 'file://', contents, trust)).toBe(true);
    expect(isTrustedMediaPermission(contents, 'media', { ...details, requestingUrl: 'file:///tmp/forged.html' }, 'file://', contents, trust)).toBe(false);
    expect(isTrustedMediaPermission(contents, 'media', details, 'http://localhost:5173', contents, trust)).toBe(false);
    expect(isTrustedMediaPermission(contents, 'media', { ...details, isMainFrame: false }, 'file://', contents, trust)).toBe(false);
  });

  it('parses security origins rather than accepting prefix lookalikes', () => {
    const development = developmentRendererTrust(validateDevelopmentServerUrl('http://localhost:5173'));
    const production = productionRendererTrust('/app/index.html');
    expect(isTrustedRendererSecurityOrigin('http://localhost:5173', development)).toBe(true);
    expect(isTrustedRendererSecurityOrigin('http://localhost:5173.attacker.example', development)).toBe(false);
    expect(isTrustedRendererSecurityOrigin('blob:http://localhost:5173/80d8e08a', development)).toBe(false);
    expect(isTrustedRendererSecurityOrigin('file://', production)).toBe(true);
    expect(isTrustedRendererSecurityOrigin('filex://attacker', production)).toBe(false);
    expect(isTrustedRendererSecurityOrigin('malformed % url', production)).toBe(false);
  });
});
