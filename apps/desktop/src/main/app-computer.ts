import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';

const SCREENSHOT_GRANT_MILLISECONDS = 15_000;

export interface AppScreenshot {
  kind: 'tinysa-atomizer-screenshot';
  screenshotId: string;
  imageDataUrl: string;
  width: number;
  height: number;
  capturedAt: string;
  focusedTarget: string;
}

export interface AppComputerResult { ok: boolean; action: string; target?: string; reason?: string; }

interface ScreenshotGrant { screenshotId: string; width: number; height: number; expiresAt: number; }
interface ActiveTarget { target: string; editable: boolean; blockedReason?: string; }

export class AppComputerHarness {
  readonly #screenshotGrants = new WeakMap<BrowserWindow, ScreenshotGrant>();

  async screenshot(win: BrowserWindow): Promise<AppScreenshot> {
    const bounds = win.getContentBounds();
    const focus = await this.#activeTarget(win);
    const image = await win.webContents.capturePage();
    const normalized = image.resize({ width: bounds.width, height: bounds.height, quality: 'good' });
    const jpeg = normalized.toJPEG(82);
    const screenshotId = randomUUID();
    const capturedAt = new Date().toISOString();
    this.#screenshotGrants.set(win, { screenshotId, width: bounds.width, height: bounds.height, expiresAt: Date.now() + SCREENSHOT_GRANT_MILLISECONDS });
    return {
      kind: 'tinysa-atomizer-screenshot', screenshotId,
      imageDataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
      width: bounds.width, height: bounds.height, capturedAt, focusedTarget: focus.target,
    };
  }

  async click(win: BrowserWindow, screenshotId: string, x: number, y: number): Promise<AppComputerResult> {
    this.#consumeScreenshot(win, screenshotId);
    this.#point(win, x, y);
    const script = `(()=>{const leaf=document.elementFromPoint(${x},${y});if(!leaf)return {ok:false,action:'click',reason:'No target at coordinates'};const target=leaf.closest('button,input,select,textarea,a,[role="button"],[data-agent-control]');if(!target)return {ok:false,action:'click',reason:'Target is not an interactive TinySA Atomizer control'};const excluded=target.closest('[data-agent-exclusion]');if(excluded)return {ok:false,action:'click',target:excluded.getAttribute('data-agent-control')||excluded.tagName,reason:'This control is a local human-only boundary'};const risky=target.closest('[data-agent-risk="high-impact"]');if(risky)return {ok:false,action:'click',target:risky.getAttribute('data-agent-control')||risky.tagName,reason:'High-impact controls require the typed approval tool'};if(target.disabled||target.getAttribute('aria-disabled')==='true')return {ok:false,action:'click',reason:'Target is disabled'};target.focus();target.click();return {ok:true,action:'click',target:target.getAttribute('data-agent-control')||target.getAttribute('aria-label')||target.textContent?.trim().slice(0,80)||target.tagName};})()`;
    return await win.webContents.executeJavaScript(script, true) as AppComputerResult;
  }

  async type(win: BrowserWindow, expectedTarget: string, text: string): Promise<AppComputerResult> {
    if (!text || text.length > 2_000) throw new Error('Computer text must be 1–2000 characters');
    const active = await this.#activeTarget(win);
    if (active.blockedReason) return { ok: false, action: 'type', target: active.target, reason: active.blockedReason };
    if (active.target !== expectedTarget) return { ok: false, action: 'type', target: active.target, reason: `Focused target changed; expected ${expectedTarget}` };
    if (!active.editable) return { ok: false, action: 'type', target: active.target, reason: 'Focused TinySA Atomizer control is not editable' };
    win.webContents.insertText(text);
    return { ok: true, action: 'type', target: active.target };
  }

  async key(win: BrowserWindow, expectedTarget: string, key: string): Promise<AppComputerResult> {
    const allowed: Record<string, { keyCode: string; modifiers?: Array<'control' | 'meta'> }> = {
      ENTER: { keyCode: 'Enter' }, ESCAPE: { keyCode: 'Escape' }, TAB: { keyCode: 'Tab' },
      ARROWUP: { keyCode: 'Up' }, ARROWDOWN: { keyCode: 'Down' }, ARROWLEFT: { keyCode: 'Left' }, ARROWRIGHT: { keyCode: 'Right' },
      BACKSPACE: { keyCode: 'Backspace' }, 'META+K': { keyCode: 'k', modifiers: ['meta'] }, 'CTRL+K': { keyCode: 'k', modifiers: ['control'] },
    };
    const value = allowed[key];
    if (!value) throw new Error('Computer key is not allow-listed');
    const active = await this.#activeTarget(win);
    if (active.blockedReason) return { ok: false, action: 'key', target: active.target, reason: active.blockedReason };
    if (active.target !== expectedTarget) return { ok: false, action: 'key', target: active.target, reason: `Focused target changed; expected ${expectedTarget}` };
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: value.keyCode, modifiers: value.modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: value.keyCode, modifiers: value.modifiers });
    return { ok: true, action: 'key', target: active.target };
  }

  async scroll(win: BrowserWindow, screenshotId: string, x: number, y: number, deltaX: number, deltaY: number): Promise<AppComputerResult> {
    this.#consumeScreenshot(win, screenshotId);
    this.#point(win, x, y);
    const guard = await win.webContents.executeJavaScript(`(()=>{const e=document.elementFromPoint(${x},${y});const boundary=e?.closest('[data-agent-exclusion],[data-agent-risk="high-impact"]');return boundary?{target:boundary.getAttribute('data-agent-control')||boundary.tagName,blockedReason:'Scroll target is a local human-only or high-impact boundary'}:{};})()`, true) as { target?: string; blockedReason?: string };
    if (guard.blockedReason) return { ok: false, action: 'scroll', target: guard.target, reason: guard.blockedReason };
    win.webContents.sendInputEvent({ type: 'mouseWheel', x, y, deltaX, deltaY, canScroll: true });
    return { ok: true, action: 'scroll', target: `${x},${y}` };
  }

  async #activeTarget(win: BrowserWindow): Promise<ActiveTarget> {
    return await win.webContents.executeJavaScript(`(()=>{const e=document.activeElement;if(!e||e===document.body||e===document.documentElement)return {target:'APPLICATION',editable:false};const control=e.closest?.('[data-agent-control]');const boundary=e.closest?.('[data-agent-exclusion],[data-agent-risk="high-impact"]');const target=(control?.getAttribute('data-agent-control')||e.getAttribute?.('data-agent-control')||e.getAttribute?.('aria-label')||e.tagName||'APPLICATION').slice(0,128);const editable=['INPUT','TEXTAREA'].includes(e.tagName)||e.isContentEditable;return boundary?{target,editable,blockedReason:'Focused control is a local human-only or high-impact boundary'}:{target,editable};})()`, true) as ActiveTarget;
  }

  #consumeScreenshot(win: BrowserWindow, screenshotId: string): void {
    const grant = this.#screenshotGrants.get(win);
    this.#screenshotGrants.delete(win);
    if (!grant || grant.screenshotId !== screenshotId) throw new Error('Computer coordinate action requires the latest unconsumed TinySA Atomizer screenshot ID');
    if (Date.now() > grant.expiresAt) throw new Error('Computer screenshot expired; capture a fresh TinySA Atomizer screenshot');
    const bounds = win.getContentBounds();
    if (bounds.width !== grant.width || bounds.height !== grant.height) throw new Error('TinySA Atomizer window geometry changed after the screenshot; capture a fresh screenshot');
  }

  #point(win: BrowserWindow, x: number, y: number): void {
    const bounds = win.getContentBounds();
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) throw new Error('Computer coordinates are outside the TinySA Atomizer window');
  }
}
