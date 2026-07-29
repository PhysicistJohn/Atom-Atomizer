// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { Root } from 'react-dom/client';
import { retainRendererRoot } from './renderer-root.js';

describe('renderer React root lifecycle', () => {
  it('reuses one root when the entry module is evaluated again by HMR', () => {
    const host = document.createElement('div');
    const root = { render: vi.fn(), unmount: vi.fn() } as unknown as Root;
    const create = vi.fn(() => root);

    expect(retainRendererRoot(host, create)).toBe(root);
    expect(retainRendererRoot(host, create)).toBe(root);
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(host);
  });
});
