import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workingDirectory = process.cwd();
const webRoot = basename(workingDirectory) === 'web'
  && basename(dirname(workingDirectory)) === 'apps'
  ? workingDirectory
  : resolve(workingDirectory, 'apps/web');

describe('browser responsive launch contract', () => {
  it('starts Atom closed throughout the compact bottom-sheet layout', () => {
    const page = readFileSync(resolve(webRoot, 'app/page.tsx'), 'utf8');

    expect(page).toContain("window.matchMedia('(max-width: 1210px)').matches");
    expect(page).not.toContain("window.matchMedia('(max-width: 880px)').matches");
  });

  it('renders the application shell without waiting for best-effort SignalLab auto-connect', () => {
    const page = readFileSync(resolve(webRoot, 'app/page.tsx'), 'utf8');

    expect(page).toContain('void appModule.then(({ App }) =>');
    expect(page).not.toContain('Promise.all([appModule, autoConnect])');
  });
});
