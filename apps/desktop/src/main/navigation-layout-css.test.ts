import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Application responsive layout contract', () => {
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

  it('keeps the I/Q plots and persistent acquisition rail bounded without scroll containers', () => {
    const css = readFileSync(resolve(process.cwd(), 'apps/desktop/src/renderer/styles.css'), 'utf8');
    const iqPlotGridRules = rulesFor(css, '.iq-plot-grid');
    const sidebarRules = rulesFor(css, '.sidebar');
    const acquisitionRailRules = rulesFor(css, '.sidebar-acquisition');

    expect(iqPlotGridRules.length).toBeGreaterThanOrEqual(2);
    expect(iqPlotGridRules[0]).toMatch(/overflow:\s*hidden/);
    for (const rule of iqPlotGridRules) expect(rule).not.toMatch(/overflow(?:-x|-y)?:\s*(?:auto|scroll)/);

    expect(sidebarRules[0]).toMatch(/min-height:\s*0/);
    expect(acquisitionRailRules[0]).toMatch(/flex:\s*0\s+0\s+auto/);
    for (const rule of acquisitionRailRules) expect(rule).not.toMatch(/position:\s*(?:absolute|fixed)|overflow(?:-x|-y)?:\s*(?:auto|scroll)/);
  });

  it('separates compact workspace navigation from the global acquisition rail', () => {
    const css = readFileSync(resolve(process.cwd(), 'apps/desktop/src/renderer/styles.css'), 'utf8');
    const sidebarRules = rulesFor(css, '.sidebar');
    const navigationRules = rulesFor(css, '.sidebar nav');
    const acquisitionRailRules = rulesFor(css, '.sidebar-acquisition');
    const acquisitionStateRules = rulesFor(css, '.sidebar-acquisition-state');

    expect(sidebarRules.at(-1)).toMatch(/flex-direction:\s*column/);
    expect(sidebarRules.at(-1)).toMatch(/overflow:\s*visible/);
    expect(navigationRules.at(-1)).toMatch(/overflow-x:\s*auto/);
    expect(acquisitionRailRules.at(-1)).toMatch(/position:\s*static/);
    expect(acquisitionRailRules.at(-1)).not.toMatch(/position:\s*sticky/);
    expect(acquisitionStateRules.at(-1)).toMatch(/justify-content:\s*flex-start/);
  });

  it('gives the compact Channel view content-sized result and setup regions', () => {
    const css = readFileSync(resolve(process.cwd(), 'apps/desktop/src/renderer/styles.css'), 'utf8');
    const channelVisualRules = rulesFor(css, '.channel-visual');
    const channelResultRules = rulesFor(css, '.channel-results > div');

    // Desktop uses a bounded plot/result stage; the final compact override
    // must replace its fixed 105 px result row so five stacked cards cannot
    // overlap the setup console below it.
    expect(channelVisualRules[0]).toMatch(/grid-template-rows:\s*minmax\(0,\s*1fr\)\s*105px/);
    expect(channelVisualRules.at(-1)).toMatch(/grid-template-rows:\s*minmax\(300px,\s*56dvh\)\s*auto/);
    expect(channelResultRules.at(-1)).toMatch(/min-height:\s*92px/);
  });
});

function rulesFor(css: string, selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...css.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g'))]
    .map((match) => match[1] ?? '');
}
