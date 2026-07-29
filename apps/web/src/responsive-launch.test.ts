import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('browser responsive launch contract', () => {
  it('starts Atom closed throughout the compact bottom-sheet layout', () => {
    const page = readFileSync(resolve(process.cwd(), 'apps/web/app/page.tsx'), 'utf8');

    expect(page).toContain("window.matchMedia('(max-width: 1210px)').matches");
    expect(page).not.toContain("window.matchMedia('(max-width: 880px)').matches");
  });
});
