import { pathToFileURL } from 'node:url';

const DEVELOPMENT_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export type RendererTrust =
  | { mode: 'development'; origin: string }
  | { mode: 'production'; url: string };

export interface RendererFrameLike {
  readonly url: string;
}

export interface RendererWebContentsLike {
  readonly mainFrame: RendererFrameLike;
}

export interface RendererIpcEventLike {
  readonly sender: unknown;
  readonly senderFrame: unknown;
}

export interface RendererPermissionDetailsLike {
  readonly isMainFrame: boolean;
  readonly requestingUrl?: string;
  readonly securityOrigin?: string;
}

/**
 * Admits only an explicit unauthenticated loopback HTTP origin. Requiring a
 * port keeps renderer trust tied to the one development server selected at
 * startup rather than to every service on the loopback host.
 */
export function validateDevelopmentServerUrl(value: string): URL {
  if (!value || value !== value.trim()) {
    throw new Error('VITE_DEV_SERVER_URL must be a non-empty URL without surrounding whitespace');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('VITE_DEV_SERVER_URL must be a valid URL');
  }
  if (url.protocol !== 'http:'
    || !DEVELOPMENT_HOSTS.has(url.hostname)
    || !url.port
    || url.username
    || url.password) {
    throw new Error('VITE_DEV_SERVER_URL must be an unauthenticated http://localhost, 127.0.0.1, or [::1] URL with an explicit port');
  }
  return url;
}

/** Packaged applications never honor a development-server environment value. */
export function selectDevelopmentServerUrl(value: string | undefined, isPackaged: boolean): URL | undefined {
  if (isPackaged || value === undefined) return undefined;
  return validateDevelopmentServerUrl(value);
}

export function productionRendererTrust(rendererPath: string): Extract<RendererTrust, { mode: 'production' }> {
  return { mode: 'production', url: pathToFileURL(rendererPath).href };
}

export function developmentRendererTrust(url: URL): Extract<RendererTrust, { mode: 'development' }> {
  return { mode: 'development', origin: validateDevelopmentServerUrl(url.href).origin };
}

/** Exact packaged URL or exact development origin (including the selected port). */
export function isTrustedRendererUrl(actual: string, expected: RendererTrust | undefined): boolean {
  if (!expected) return false;
  try {
    const url = new URL(actual);
    return expected.mode === 'development'
      ? url.protocol === 'http:' && url.origin === expected.origin
      : url.href === expected.url;
  } catch {
    return false;
  }
}

/**
 * Electron IPC is admitted only from the current app window's exact main
 * frame. Matching a URL alone is insufficient because another WebContents or
 * an embedded frame can load the same URL.
 */
export function isTrustedRendererEvent(
  event: unknown,
  expectedWebContents: RendererWebContentsLike | undefined,
  expected: RendererTrust | undefined,
): event is RendererIpcEventLike {
  if (!expectedWebContents || !expected || !isRecord(event)) return false;
  try {
    const sender = Reflect.get(event, 'sender');
    const senderFrame = Reflect.get(event, 'senderFrame');
    return sender === expectedWebContents
      && senderFrame === expectedWebContents.mainFrame
      && isRecord(senderFrame)
      && typeof Reflect.get(senderFrame, 'url') === 'string'
      && isTrustedRendererUrl(Reflect.get(senderFrame, 'url') as string, expected);
  } catch {
    return false;
  }
}

export function assertTrustedRendererEvent(
  event: unknown,
  expectedWebContents: RendererWebContentsLike | undefined,
  expected: RendererTrust | undefined,
): void {
  if (!isTrustedRendererEvent(event, expectedWebContents, expected)) {
    throw new Error('Rejected IPC from an untrusted renderer frame or origin');
  }
}

/**
 * Media permissions are restricted to the same current main-frame URL used by
 * IPC trust. For file URLs, the security origin is necessarily opaque, so the
 * exact requesting URL and WebContents identity remain mandatory.
 */
export function isTrustedMediaPermission(
  webContents: unknown,
  permission: string,
  details: RendererPermissionDetailsLike,
  requestingOrigin: string | undefined,
  expectedWebContents: RendererWebContentsLike | undefined,
  expected: RendererTrust | undefined,
): boolean {
  if (permission !== 'media'
    || !expectedWebContents
    || webContents !== expectedWebContents
    || !details.isMainFrame
    || typeof details.requestingUrl !== 'string'
    || !isTrustedRendererUrl(details.requestingUrl, expected)
    || !isTrustedRendererUrl(expectedWebContents.mainFrame.url, expected)) {
    return false;
  }
  const origin = requestingOrigin ?? details.securityOrigin ?? details.requestingUrl;
  return isTrustedRendererSecurityOrigin(origin, expected);
}

export function isTrustedRendererSecurityOrigin(actual: string, expected: RendererTrust | undefined): boolean {
  if (!expected) return false;
  try {
    const url = new URL(actual);
    if (expected.mode === 'development') return url.protocol === 'http:' && url.origin === expected.origin;
    // file: has an opaque origin. This check is safe only in conjunction with
    // the exact requesting URL and WebContents checks above.
    return url.protocol === 'file:' && new URL(expected.url).protocol === 'file:';
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null;
}
