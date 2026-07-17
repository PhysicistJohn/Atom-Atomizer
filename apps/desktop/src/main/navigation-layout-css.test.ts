import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Detect responsive layout contract', () => {
  it('keeps the grid and its bottom status row non-scrolling at every breakpoint', () => {
    const css = readFileSync(resolve(process.cwd(), 'apps/desktop/src/renderer/styles.css'), 'utf8');
    const detectGridRules = rulesFor(css, '.classification-grid');
    const statusStripRules = rulesFor(css, '.classification-capture-strip');

    expect(detectGridRules.length).toBeGreaterThanOrEqual(2);
    expect(detectGridRules[0]).toMatch(/overflow:\s*hidden/);
    for (const rule of detectGridRules) expect(rule).not.toMatch(/overflow(?:-x|-y)?:\s*(?:auto|scroll)/);

    expect(statusStripRules[0]).toMatch(/grid-template-columns:\s*minmax\(0,\s*1\.15fr\)\s*minmax\(0,\s*\.85fr\)\s*minmax\(0,\s*\.9fr\)\s*auto/);
    expect(statusStripRules[0]).toMatch(/overflow:\s*hidden/);
    for (const rule of statusStripRules) {
      expect(rule).not.toMatch(/overflow(?:-x|-y)?:\s*(?:auto|scroll)/);
      expect(rule).not.toMatch(/position:\s*sticky/);
    }
  });
});

function rulesFor(css: string, selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...css.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g'))]
    .map((match) => match[1] ?? '');
}
