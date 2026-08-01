import { describe, expect, it } from 'vitest';
import { augmentedGuiLaunchPath, restoreGuiLaunchPath } from './gui-launch-path.js';

describe('augmentedGuiLaunchPath', () => {
  it('prepends an existing, not-already-present candidate directory', () => {
    const exists = (path: string) => path === '/Users/x/.local/bin';
    expect(augmentedGuiLaunchPath('/usr/bin:/bin', ['/Users/x/.local/bin'], exists))
      .toBe('/Users/x/.local/bin:/usr/bin:/bin');
  });

  it('never adds a candidate directory that does not exist on disk', () => {
    const exists = () => false;
    expect(augmentedGuiLaunchPath('/usr/bin:/bin', ['/opt/homebrew/bin'], exists))
      .toBe('/usr/bin:/bin');
  });

  it('never duplicates a candidate directory already present in PATH', () => {
    const exists = () => true;
    expect(augmentedGuiLaunchPath('/opt/homebrew/bin:/usr/bin', ['/opt/homebrew/bin'], exists))
      .toBe('/opt/homebrew/bin:/usr/bin');
  });

  it('adds multiple existing candidates in declared order, ahead of the original entries', () => {
    const exists = (path: string) => path === '/a' || path === '/c';
    expect(augmentedGuiLaunchPath('/usr/bin', ['/a', '/b', '/c'], exists))
      .toBe('/a:/c:/usr/bin');
  });

  it('treats an undefined/empty PATH as no existing entries, not an error', () => {
    const exists = () => true;
    expect(augmentedGuiLaunchPath(undefined, ['/opt/homebrew/bin'], exists))
      .toBe('/opt/homebrew/bin');
    expect(augmentedGuiLaunchPath('', ['/opt/homebrew/bin'], exists))
      .toBe('/opt/homebrew/bin');
  });

});

describe('restoreGuiLaunchPath', () => {
  it('is a no-op on platforms outside darwin/linux', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const env = { PATH: '/usr/bin' } as NodeJS.ProcessEnv;
      restoreGuiLaunchPath(env);
      expect(env.PATH).toBe('/usr/bin');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });
});
