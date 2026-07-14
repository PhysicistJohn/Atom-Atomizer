import { describe, expect, it, vi } from 'vitest';
import { AppComputerHarness } from './app-computer.js';

function fakeWindow() {
  const normalized = { toJPEG: vi.fn().mockReturnValue(Buffer.from('image')) };
  const image = { resize: vi.fn().mockReturnValue(normalized) };
  const webContents = {
    capturePage: vi.fn().mockResolvedValue(image),
    executeJavaScript: vi.fn().mockResolvedValue({ target: 'APPLICATION', editable: false }),
    insertText: vi.fn(), sendInputEvent: vi.fn(),
  };
  return { win: { getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }), webContents }, webContents, image };
}

async function screenshot(harness: AppComputerHarness, win: ReturnType<typeof fakeWindow>['win']) {
  return harness.screenshot(win as never);
}

describe('app-scoped computer harness', () => {
  it('captures only application content and issues focus-bound coordinate evidence', async () => {
    const { win, image } = fakeWindow();
    const shot = await screenshot(new AppComputerHarness(), win);
    expect(image.resize).toHaveBeenCalledWith({ width: 1200, height: 800, quality: 'good' });
    expect(shot.imageDataUrl).toMatch(/^data:image\/jpeg;base64,/);
    expect(shot.screenshotId).toMatch(/^[0-9a-f-]{36}$/);
    expect(shot.focusedTarget).toBe('APPLICATION');
  });

  it('requires the latest screenshot, bounds coordinates, and consumes each ID once', async () => {
    const { win, webContents } = fakeWindow();
    const harness = new AppComputerHarness();
    await expect(harness.click(win as never, '123e4567-e89b-42d3-a456-426614174000', 10, 20)).rejects.toThrow(/latest unconsumed/);
    const outOfBounds = await screenshot(harness, win);
    await expect(harness.click(win as never, outOfBounds.screenshotId, 1200, 20)).rejects.toThrow(/outside/);
    await expect(harness.click(win as never, outOfBounds.screenshotId, 10, 20)).rejects.toThrow(/latest unconsumed/);
    const valid = await screenshot(harness, win);
    webContents.executeJavaScript.mockResolvedValueOnce({ ok: false, action: 'click', reason: 'High-impact controls require the typed approval tool' });
    const result = await harness.click(win as never, valid.screenshotId, 10, 20);
    expect(result.ok).toBe(false);
    expect(String(webContents.executeJavaScript.mock.calls.at(-1)?.[0])).toContain('data-agent-risk');
    expect(String(webContents.executeJavaScript.mock.calls.at(-1)?.[0])).toContain('data-agent-exclusion');
  });

  it('allows only declared keys and requires an exact focused target', async () => {
    const { win, webContents } = fakeWindow();
    const harness = new AppComputerHarness();
    webContents.executeJavaScript.mockResolvedValue({ target: 'analyzer.start', editable: true });
    await expect(harness.key(win as never, 'analyzer.start', 'DELETE')).rejects.toThrow(/allow-listed/);
    expect(await harness.key(win as never, 'wrong-target', 'ENTER')).toMatchObject({ ok: false, target: 'analyzer.start' });
    await harness.key(win as never, 'analyzer.start', 'ENTER');
    expect(webContents.sendInputEvent).toHaveBeenCalledTimes(2);
    expect(await harness.type(win as never, 'wrong-target', '98 MHz')).toMatchObject({ ok: false, target: 'analyzer.start' });
    await harness.type(win as never, 'analyzer.start', '98 MHz');
    expect(webContents.insertText).toHaveBeenCalledWith('98 MHz');
  });

  it('blocks click, type, key, and scroll at local human-only boundaries', async () => {
    const { win, webContents } = fakeWindow();
    const harness = new AppComputerHarness();
    const clickShot = await screenshot(harness, win);
    webContents.executeJavaScript.mockResolvedValueOnce({ ok: false, action: 'click', target: 'atom.microphone-mute', reason: 'local human-only boundary' });
    expect(await harness.click(win as never, clickShot.screenshotId, 10, 20)).toMatchObject({ ok: false, target: 'atom.microphone-mute' });
    webContents.executeJavaScript.mockResolvedValue({ target: 'atom.microphone-mute', editable: true, blockedReason: 'local human-only boundary' });
    expect(await harness.type(win as never, 'atom.microphone-mute', 'MUTE')).toMatchObject({ ok: false, target: 'atom.microphone-mute' });
    expect(await harness.key(win as never, 'atom.microphone-mute', 'ENTER')).toMatchObject({ ok: false, target: 'atom.microphone-mute' });
    const scrollShot = await screenshot(harness, win);
    webContents.executeJavaScript.mockResolvedValueOnce({ target: 'atom.microphone-mute', blockedReason: 'local human-only boundary' });
    expect(await harness.scroll(win as never, scrollShot.screenshotId, 10, 20, 0, 100)).toMatchObject({ ok: false, target: 'atom.microphone-mute' });
    expect(webContents.insertText).not.toHaveBeenCalled();
    expect(webContents.sendInputEvent).not.toHaveBeenCalled();
  });
});
