import { describe, expect, it, vi } from 'vitest';
import { AppComputerHarness } from './app-computer.js';

function fakeWindow(input: {
  bounds?: { x: number; y: number; width: number; height: number };
  capturedSize?: { width: number; height: number };
  normalizedSize?: { width: number; height: number };
  jpeg?: Buffer;
  bitmap?: Buffer;
  empty?: boolean;
} = {}) {
  const bounds = input.bounds ?? { x: 0, y: 0, width: 1200, height: 800 };
  const normalizedSize = input.normalizedSize ?? { width: bounds.width, height: bounds.height };
  const normalized = {
    getSize: vi.fn().mockReturnValue(normalizedSize),
    toJPEG: vi.fn().mockReturnValue(input.jpeg ?? Buffer.from('image')),
    // Keep the native-image allocation lazy. Unsafe geometry is supposed to
    // be rejected before capture, so constructing that fixture must not try
    // to allocate the very buffer the production guard prevents.
    toBitmap: vi.fn(() => input.bitmap ?? Buffer.alloc(normalizedSize.width * normalizedSize.height * 4)),
  };
  const image = {
    isEmpty: vi.fn().mockReturnValue(input.empty ?? false),
    getSize: vi.fn().mockReturnValue(input.capturedSize ?? { width: 2400, height: 1600 }),
    resize: vi.fn().mockReturnValue(normalized),
    toJPEG: normalized.toJPEG,
    toBitmap: normalized.toBitmap,
  };
  const webContents = {
    capturePage: vi.fn().mockResolvedValue(image),
    insertCSS: vi.fn().mockResolvedValue('capture-css-key'),
    removeInsertedCSS: vi.fn().mockResolvedValue(undefined),
    executeJavaScript: vi.fn().mockResolvedValue({ target: 'APPLICATION', editable: false }),
    insertText: vi.fn(), sendInputEvent: vi.fn(),
  };
  return { win: { getContentBounds: vi.fn(() => bounds), webContents }, webContents, image, normalized, bounds };
}

async function screenshot(harness: AppComputerHarness, win: ReturnType<typeof fakeWindow>['win']) {
  return harness.screenshot(win as never);
}

function harness(scaleFactor = 1): AppComputerHarness {
  return new AppComputerHarness(() => scaleFactor);
}

describe('app-scoped computer harness', () => {
  it('captures only application content and issues focus-bound coordinate evidence', async () => {
    const { win, image } = fakeWindow();
    const shot = await screenshot(harness(2), win);
    expect(win.webContents.capturePage).toHaveBeenCalledWith({ x: 0, y: 0, width: 1200, height: 800 });
    expect(win.webContents.insertCSS).toHaveBeenCalledWith(expect.stringContaining('animation: none'), { cssOrigin: 'user' });
    expect(win.webContents.removeInsertedCSS).toHaveBeenCalledWith('capture-css-key');
    expect(image.resize).toHaveBeenCalledWith({ width: 1200, height: 800, quality: 'good' });
    expect(shot.imageDataUrl).toMatch(/^data:image\/jpeg;base64,/);
    expect(shot.screenshotId).toMatch(/^[0-9a-f-]{36}$/);
    expect(shot.focusedTarget).toBe('APPLICATION');
  });

  it('fails before native capture for unsafe application geometry', async () => {
    const { win, webContents } = fakeWindow({ bounds: { x: 0, y: 0, width: 65_536, height: 32_768 } });
    await expect(screenshot(harness(), win)).rejects.toThrow(/bounded screenshot allocation/);
    expect(webContents.capturePage).not.toHaveBeenCalled();
  });

  it('bounds the Retina backing allocation before asking Chromium to capture', async () => {
    const { win, webContents } = fakeWindow({ bounds: { x: 0, y: 0, width: 4096, height: 4096 } });
    await expect(screenshot(harness(2), win)).rejects.toThrow(/backing image dimensions.*bounded screenshot allocation/);
    expect(webContents.capturePage).not.toHaveBeenCalled();
  });

  it('fails closed on invalid display scale factors before native capture', async () => {
    for (const scaleFactor of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { win, webContents } = fakeWindow();
      await expect(screenshot(harness(scaleFactor), win)).rejects.toThrow(/display scale factor.*bounded screenshot allocation/);
      expect(webContents.capturePage).not.toHaveBeenCalled();
    }
  });

  it('revalidates geometry and display scale after querying the renderer', async () => {
    const resized = fakeWindow();
    vi.spyOn(resized.win, 'getContentBounds')
      .mockReturnValueOnce({ x: 0, y: 0, width: 1200, height: 800 })
      .mockReturnValue({ x: 0, y: 0, width: 8192, height: 8192 });
    await expect(screenshot(harness(), resized.win)).rejects.toThrow(/geometry changed before the screenshot/);
    expect(resized.webContents.capturePage).not.toHaveBeenCalled();

    const movedToDenserDisplay = fakeWindow();
    let scaleQuery = 0;
    const changingScaleHarness = new AppComputerHarness(() => scaleQuery++ === 0 ? 1 : 8);
    await expect(screenshot(changingScaleHarness, movedToDenserDisplay.win)).rejects.toThrow(/backing image dimensions.*bounded screenshot allocation/);
    expect(movedToDenserDisplay.webContents.capturePage).not.toHaveBeenCalled();
  });

  it('rejects empty, oversized, malformed, or unexpectedly normalized native images', async () => {
    const empty = fakeWindow({ empty: true });
    await expect(screenshot(harness(), empty.win)).rejects.toThrow(/empty image/);

    const oversized = fakeWindow({ capturedSize: { width: 8192, height: 8192 } });
    await expect(screenshot(harness(), oversized.win)).rejects.toThrow(/bounded screenshot allocation/);
    expect(oversized.image.resize).not.toHaveBeenCalled();

    const malformed = fakeWindow({ capturedSize: { width: Number.NaN, height: 800 } });
    await expect(screenshot(harness(), malformed.win)).rejects.toThrow(/bounded screenshot allocation/);

    const wrongNormalizedSize = fakeWindow({ normalizedSize: { width: 1199, height: 800 } });
    await expect(screenshot(harness(), wrongNormalizedSize.win)).rejects.toThrow(/unexpected dimensions/);
  });

  it('rejects a JPEG that cannot fit the bounded Agent image IPC payload', async () => {
    const { win } = fakeWindow({ jpeg: Buffer.alloc(8_000_001) });
    await expect(screenshot(harness(), win)).rejects.toThrow(/bounded Agent image payload/);
  });

  it('rejects an empty or truncated normalized bitmap before issuing coordinate evidence', async () => {
    const { win, webContents } = fakeWindow({ bitmap: Buffer.alloc(0) });
    await expect(screenshot(harness(), win)).rejects.toThrow(/bounded visual-state comparison payload/);
    expect(webContents.removeInsertedCSS).toHaveBeenCalledWith('capture-css-key');

    const truncated = fakeWindow({ bitmap: Buffer.alloc(1200 * 800 * 4 - 1) });
    await expect(screenshot(harness(), truncated.win)).rejects.toThrow(/bounded visual-state comparison payload/);
  });

  it('requires the latest screenshot, bounds coordinates, and consumes each ID once', async () => {
    const { win, webContents } = fakeWindow();
    const computer = harness();
    await expect(computer.click(win as never, '123e4567-e89b-42d3-a456-426614174000', 10, 20)).rejects.toThrow(/latest unconsumed/);
    const outOfBounds = await screenshot(computer, win);
    await expect(computer.click(win as never, outOfBounds.screenshotId, 1200, 20)).rejects.toThrow(/outside/);
    await expect(computer.click(win as never, outOfBounds.screenshotId, 10, 20)).rejects.toThrow(/latest unconsumed/);
    const valid = await screenshot(computer, win);
    webContents.executeJavaScript.mockResolvedValueOnce({ ok: false, action: 'click', reason: 'High-impact controls require the typed approval tool' });
    const result = await computer.click(win as never, valid.screenshotId, 10, 20);
    expect(result.ok).toBe(false);
    expect(String(webContents.executeJavaScript.mock.calls.at(-1)?.[0])).toContain('data-agent-risk');
    expect(String(webContents.executeJavaScript.mock.calls.at(-1)?.[0])).toContain('data-agent-exclusion');
    expect(String(webContents.executeJavaScript.mock.calls.at(-1)?.[0])).not.toContain('textContent');
  });

  it('binds each coordinate grant to the exact normalized application bitmap', async () => {
    const { win, webContents, normalized } = fakeWindow();
    const computer = harness();
    const capturedVisual = Buffer.alloc(1200 * 800 * 4);
    const changedVisual = Buffer.from(capturedVisual);
    changedVisual[0] = 1;
    normalized.toBitmap
      .mockReturnValueOnce(capturedVisual)
      .mockReturnValue(changedVisual);
    const shot = await screenshot(computer, win);

    await expect(computer.click(win as never, shot.screenshotId, 310, 220))
      .rejects.toThrow(/visual state changed.*fresh screenshot/i);
    expect(webContents.executeJavaScript).toHaveBeenCalledTimes(2);
    await expect(computer.click(win as never, shot.screenshotId, 310, 220))
      .rejects.toThrow(/latest unconsumed/i);
  });

  it('delivers spectrum marker coordinates as a pointer event while preserving ordinary DOM clicks', async () => {
    const { win, webContents } = fakeWindow();
    const computer = harness();
    const shot = await screenshot(computer, win);
    webContents.executeJavaScript.mockResolvedValueOnce({ ok: true, action: 'click', target: 'spectrum.marker-place' });

    await expect(computer.click(win as never, shot.screenshotId, 310, 220)).resolves.toMatchObject({ ok: true, target: 'spectrum.marker-place' });
    const script = String(webContents.executeJavaScript.mock.calls.at(-1)?.[0]);
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain("controlId==='spectrum.marker-place'");
    expect(script).toContain("new PointerEvent('pointerdown'");
    expect(script).toContain("Object.defineProperty(markerEvent,'__tinysaAtomMarkerRequestV1'");
    expect(script).toContain("markerEvent['__tinysaAtomMarkerResultV1']");
    expect(script).toContain('Marker placement was not acknowledged by the renderer');
    expect(script).toContain('Number.isSafeInteger(acknowledgement.frequencyHz)');
    expect(script).toContain('clientX:310');
    expect(script).toContain('clientY:220');
    expect(script).toContain('Marker coordinate is outside the measured spectrum plot');
    expect(script).toContain('target.click()');
    const actionOrder = webContents.executeJavaScript.mock.invocationCallOrder.at(-1);
    const recaptureOrder = webContents.capturePage.mock.invocationCallOrder.at(-1);
    const normalizationCleanupOrder = webContents.removeInsertedCSS.mock.invocationCallOrder.at(-1);
    expect(recaptureOrder).toBeLessThan(actionOrder!);
    expect(normalizationCleanupOrder).toBeGreaterThan(actionOrder!);
  });

  it('uses ancestor-aware disabled semantics before any coordinate click', async () => {
    const { win, webContents } = fakeWindow();
    const computer = harness();
    const shot = await screenshot(computer, win);
    webContents.executeJavaScript.mockResolvedValueOnce({ ok: false, action: 'click', target: 'analyzer.start', reason: 'Target is disabled' });

    await expect(computer.click(win as never, shot.screenshotId, 310, 220))
      .resolves.toMatchObject({ ok: false, target: 'analyzer.start', reason: 'Target is disabled' });
    const script = String(webContents.executeJavaScript.mock.calls.at(-1)?.[0]);
    expect(script).toContain('controlIsDisabled(target)');
    expect(script).toContain('controlIsDisabled(leaf)');
    expect(script).toContain("target.closest?.('[aria-disabled=\"true\"],.disabled,:disabled')");
    expect(script).toContain("target.querySelector?.(':disabled')");
    expect(script).toContain("const excluded=leaf.closest('[data-agent-exclusion]')");
    expect(script).toContain("const risky=leaf.closest('[data-agent-risk=\"high-impact\"]')");
    expect(script).toContain('target:focus.target');
  });

  it('rejects guessed focus targets without screenshot or successful-action provenance', async () => {
    const { win, webContents } = fakeWindow();
    const computer = harness();
    webContents.executeJavaScript.mockResolvedValue({ target: 'analyzer.start', editable: true });
    await expect(computer.key(win as never, 'analyzer.start', 'ENTER')).rejects.toThrow(/trusted target/);
    await expect(computer.type(win as never, 'analyzer.start', '98 MHz')).rejects.toThrow(/trusted target/);
    expect(webContents.executeJavaScript).not.toHaveBeenCalled();
    expect(webContents.insertText).not.toHaveBeenCalled();
    expect(webContents.sendInputEvent).not.toHaveBeenCalled();
  });

  it('rotates focus authority through screenshots and successful guarded actions', async () => {
    const { win, webContents } = fakeWindow();
    const computer = harness();
    webContents.executeJavaScript.mockResolvedValue({ target: 'analyzer.start', editable: true });
    await screenshot(computer, win);
    await expect(computer.key(win as never, 'analyzer.start', 'DELETE')).rejects.toThrow(/allow-listed/);
    await expect(computer.key(win as never, 'wrong-target', 'ENTER')).rejects.toThrow(/latest trusted focus evidence/);

    await screenshot(computer, win);
    webContents.executeJavaScript
      .mockResolvedValueOnce({ ok: true, action: 'key', target: 'analyzer.start', armed: true })
      .mockResolvedValueOnce({ ok: true, action: 'key', target: 'analyzer.start' });
    expect(await computer.key(win as never, 'analyzer.start', 'ENTER')).toMatchObject({ ok: true, target: 'analyzer.start' });
    expect(webContents.sendInputEvent).toHaveBeenCalledTimes(2);
    await expect(computer.type(win as never, 'wrong-target', '98 MHz')).rejects.toThrow(/latest trusted focus evidence/);

    await screenshot(computer, win);
    webContents.executeJavaScript
      .mockResolvedValueOnce({ ok: true, action: 'type', target: 'analyzer.start', armed: true })
      .mockResolvedValueOnce({ ok: true, action: 'type', target: 'analyzer.start' });
    expect(await computer.type(win as never, 'analyzer.start', '98 MHz')).toMatchObject({ ok: true, target: 'analyzer.start' });
    expect(webContents.insertText).toHaveBeenCalledWith('98 MHz');
    const armScripts = webContents.executeJavaScript.mock.calls.map(call => String(call[0])).filter(script => script.includes('InputEvent') || script.includes('KeyboardEvent'));
    expect(armScripts).toHaveLength(2);
    for (const script of armScripts) {
      expect(script).toContain('stopImmediatePropagation');
      expect(script).toContain('inspectActiveTarget');
      expect(script).toContain('Focused target changed immediately before native input delivery');
      expect(script).not.toContain('textContent');
      expect(script).not.toContain('.value');
    }
  });

  it('reports delivery-time focus races as blocked and does not refresh their consumed grants', async () => {
    const { win, webContents } = fakeWindow();
    const computer = harness();
    webContents.executeJavaScript.mockResolvedValue({ target: 'analyzer.start', editable: true });
    await screenshot(computer, win);
    webContents.executeJavaScript
      .mockResolvedValueOnce({ ok: true, action: 'key', target: 'analyzer.start', armed: true })
      .mockResolvedValueOnce({ ok: false, action: 'key', target: 'atom.microphone-mute', reason: 'Focused target changed immediately before native input delivery' });
    expect(await computer.key(win as never, 'analyzer.start', 'ENTER')).toMatchObject({ ok: false, target: 'atom.microphone-mute' });
    await expect(computer.key(win as never, 'analyzer.start', 'ENTER')).rejects.toThrow(/trusted target/);
  });

  it('immediately cancels an armed renderer guard when native injection throws', async () => {
    const { win, webContents } = fakeWindow();
    const computer = harness();
    webContents.executeJavaScript.mockResolvedValue({ target: 'analyzer.start', editable: true });
    await screenshot(computer, win);
    webContents.executeJavaScript.mockResolvedValueOnce({ ok: true, action: 'key', target: 'analyzer.start', armed: true });
    webContents.sendInputEvent.mockImplementationOnce(() => { throw new Error('native injection failed'); });

    await expect(computer.key(win as never, 'analyzer.start', 'ENTER')).rejects.toThrow(/native injection failed/);
    const scripts = webContents.executeJavaScript.mock.calls.map(call => String(call[0]));
    expect(scripts.at(-2)).toContain('const record={cancel,wait:');
    expect(scripts.at(-1)).toContain("typeof record.cancel!=='function'");
    expect(scripts.at(-1)).toContain('record.cancel()');
  });

  it('blocks click, type, key, and scroll at local human-only boundaries', async () => {
    const { win, webContents } = fakeWindow();
    const computer = harness();
    const clickShot = await screenshot(computer, win);
    webContents.executeJavaScript.mockResolvedValueOnce({ ok: false, action: 'click', target: 'atom.microphone-mute', reason: 'local human-only boundary' });
    expect(await computer.click(win as never, clickShot.screenshotId, 10, 20)).toMatchObject({ ok: false, target: 'atom.microphone-mute' });

    webContents.executeJavaScript.mockResolvedValue({ target: 'atom.microphone-mute', editable: true, blockedReason: 'local human-only boundary' });
    await screenshot(computer, win);
    webContents.executeJavaScript.mockResolvedValueOnce({ ok: false, action: 'type', target: 'atom.microphone-mute', reason: 'local human-only boundary' });
    expect(await computer.type(win as never, 'atom.microphone-mute', 'MUTE')).toMatchObject({ ok: false, target: 'atom.microphone-mute' });

    await screenshot(computer, win);
    webContents.executeJavaScript.mockResolvedValueOnce({ ok: false, action: 'key', target: 'atom.microphone-mute', reason: 'local human-only boundary' });
    expect(await computer.key(win as never, 'atom.microphone-mute', 'ENTER')).toMatchObject({ ok: false, target: 'atom.microphone-mute' });

    const scrollShot = await screenshot(computer, win);
    webContents.executeJavaScript.mockResolvedValueOnce({ ok: false, action: 'scroll', target: 'atom.microphone-mute', reason: 'local human-only boundary' });
    expect(await computer.scroll(win as never, scrollShot.screenshotId, 10, 20, 0, 100)).toMatchObject({ ok: false, target: 'atom.microphone-mute' });
    expect(webContents.insertText).not.toHaveBeenCalled();
    expect(webContents.sendInputEvent).not.toHaveBeenCalled();
  });

  it('revalidates geometry and scale after the awaited scroll hit-test before native input', async () => {
    const resized = fakeWindow();
    const resizeComputer = harness();
    const resizeShot = await screenshot(resizeComputer, resized.win);
    resized.webContents.executeJavaScript.mockImplementationOnce(async () => {
      resized.bounds.width = 1199;
      return { ok: true, action: 'scroll', target: '10,20', armed: true };
    });
    await expect(resizeComputer.scroll(resized.win as never, resizeShot.screenshotId, 10, 20, 0, 100)).rejects.toThrow(/geometry changed after the screenshot/);
    expect(resized.webContents.sendInputEvent).not.toHaveBeenCalled();

    const denser = fakeWindow();
    let scaleFactor = 1;
    const scaleComputer = new AppComputerHarness(() => scaleFactor);
    const scaleShot = await screenshot(scaleComputer, denser.win);
    denser.webContents.executeJavaScript.mockImplementationOnce(async () => {
      scaleFactor = 2;
      return { ok: true, action: 'scroll', target: '10,20', armed: true };
    });
    await expect(scaleComputer.scroll(denser.win as never, scaleShot.screenshotId, 10, 20, 0, 100)).rejects.toThrow(/display scale changed after the screenshot/);
    expect(denser.webContents.sendInputEvent).not.toHaveBeenCalled();
  });

  it('guards scroll again at native event delivery after the post-hit-test native recheck', async () => {
    const { win, webContents } = fakeWindow();
    const computer = harness();
    const shot = await screenshot(computer, win);
    webContents.executeJavaScript
      .mockResolvedValueOnce({ ok: true, action: 'scroll', target: '10,20', armed: true })
      .mockResolvedValueOnce({ ok: false, action: 'scroll', target: 'atom.microphone-mute', reason: 'Coordinate target is a local human-only or high-impact boundary' });
    expect(await computer.scroll(win as never, shot.screenshotId, 10, 20, 0, 100)).toMatchObject({ ok: false, target: 'atom.microphone-mute' });
    expect(webContents.sendInputEvent).toHaveBeenCalledTimes(1);
    const armScript = String(webContents.executeJavaScript.mock.calls.at(-2)?.[0]);
    expect(armScript).toContain('window.addEventListener("wheel"');
    expect(armScript).toContain('rendererGeometryMatches');
    expect(armScript).toContain('coordinateBoundary');
    expect(armScript).toContain('stopImmediatePropagation');
    expect(armScript).toContain('Math.round(event.deltaX)!==0');
    expect(armScript).toContain('Math.round(event.deltaY)!==100');
    expect(armScript).toContain('Native input did not match the armed scroll action');
    expect(armScript).toContain('finish(timeoutResult)');
    expect(armScript).toContain('dispose();resolve(timeoutResult)');
  });
});
