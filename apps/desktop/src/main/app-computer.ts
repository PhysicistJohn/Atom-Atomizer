import { createHash, randomUUID } from 'node:crypto';
import type { BrowserWindow, NativeImage, Rectangle } from 'electron';

const SCREENSHOT_GRANT_MILLISECONDS = 15_000;
const NATIVE_INPUT_WAIT_MILLISECONDS = 2_000;
const NATIVE_INPUT_GUARD_MILLISECONDS = 15_000;
const MAX_SCREENSHOT_DIMENSION = 8_192;
const MAX_SCREENSHOT_PIXELS = 16_777_216;
// The auxiliary IPC contract admits data URLs below 12 million characters.
// Eight million JPEG bytes remain comfortably below that ceiling after base64.
const MAX_SCREENSHOT_JPEG_BYTES = 8_000_000;
// Coordinate evidence must remain usable while Atom's voice rings, sweep
// loader, carets, and transient panels animate. Capture and recapture the exact
// deterministic frame that Atom sees instead of hashing animation phase.
const SCREENSHOT_NORMALIZATION_CSS = `
*,*::before,*::after {
  animation: none !important;
  transition: none !important;
  caret-color: transparent !important;
}`;

export interface AppScreenshot {
  kind: 'atomizer-screenshot';
  screenshotId: string;
  imageDataUrl: string;
  width: number;
  height: number;
  capturedAt: string;
  focusedTarget: string;
}

export interface AppComputerResult { ok: boolean; action: string; target?: string; reason?: string; }

interface ScreenshotGrant { screenshotId: string; width: number; height: number; scaleFactor: number; visualSha256: string; expiresAt: number; }
interface FocusGrant { target: string; expiresAt: number; }
interface ActiveTarget { target: string; editable: boolean; blockedReason?: string; }
interface RendererComputerResult extends AppComputerResult { armed?: boolean; focusGrantBlocked?: boolean; markerFrequencyHz?: number; }

interface GuardedNativeInput {
  action: 'type' | 'key' | 'scroll';
  expectedTarget?: string;
  requireEditable?: boolean;
  text?: string;
  domKey?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  scaleFactor?: number;
  deltaX?: number;
  deltaY?: number;
}

const RENDERER_TARGET_HELPERS = `
const inspectActiveTarget=()=>{const e=document.activeElement;if(!e||e===document.body||e===document.documentElement)return {target:'APPLICATION',editable:false};const control=e.closest?.('[data-agent-control]');const boundary=e.closest?.('[data-agent-exclusion],[data-agent-risk="high-impact"]');const target=String(control?.getAttribute('data-agent-control')||e.getAttribute?.('data-agent-control')||e.getAttribute?.('aria-label')||e.tagName||'APPLICATION').slice(0,128);const editable=['INPUT','TEXTAREA'].includes(e.tagName)||e.isContentEditable;return boundary?{target,editable,blockedReason:'Focused control is a local human-only or high-impact boundary'}:{target,editable};};
const rendererGeometryMatches=(width,height,scaleFactor)=>window.innerWidth===width&&window.innerHeight===height&&Number.isFinite(window.devicePixelRatio)&&Math.abs(window.devicePixelRatio-scaleFactor)<1e-6;
const controlIsDisabled=(target)=>Boolean(target.closest?.('[aria-disabled="true"],.disabled,:disabled'))||target.getAttribute?.('aria-disabled')==='true'||target.classList?.contains('disabled')||target.matches?.(':disabled')||Boolean(target.querySelector?.(':disabled'));
const coordinateBoundary=(x,y)=>{const e=document.elementFromPoint(x,y);const boundary=e?.closest('[data-agent-exclusion],[data-agent-risk="high-impact"]');return boundary?{target:String(boundary.getAttribute('data-agent-control')||boundary.getAttribute('aria-label')||boundary.tagName||'APPLICATION').slice(0,128),blockedReason:'Coordinate target is a local human-only or high-impact boundary'}:{};};`;

export class AppComputerHarness {
  readonly #screenshotGrants = new WeakMap<BrowserWindow, ScreenshotGrant>();
  readonly #focusGrants = new WeakMap<BrowserWindow, FocusGrant>();
  readonly #displayScaleFactor: (bounds: Rectangle) => number;
  readonly #rendererGuardNamespace = `__tinysaAtomInputGuardsV1_${randomUUID().replaceAll('-', '')}`;

  constructor(displayScaleFactor: (bounds: Rectangle) => number) {
    this.#displayScaleFactor = displayScaleFactor;
  }

  async screenshot(win: BrowserWindow): Promise<AppScreenshot> {
    const bounds = win.getContentBounds();
    assertSafeScreenshotSize('application content', bounds);
    const scaleFactor = this.#displayScaleFactor(bounds);
    assertSafeScreenshotBackingSize(bounds, scaleFactor);
    const focus = await this.#activeTarget(win);
    // activeTarget crosses the renderer boundary. Re-read the geometry and
    // scale factor afterward so a resize or move to a denser display cannot
    // bypass the native allocation guard while that request is in flight.
    const captureBounds = win.getContentBounds();
    if (captureBounds.width !== bounds.width || captureBounds.height !== bounds.height) {
      throw new Error('Atomizer window geometry changed before the screenshot; capture a fresh screenshot');
    }
    const captureScaleFactor = this.#displayScaleFactor(captureBounds);
    assertSafeScreenshotBackingSize(bounds, captureScaleFactor);
    if (captureScaleFactor !== scaleFactor) {
      throw new Error('Atomizer display scale changed before the screenshot; capture a fresh screenshot');
    }
    // Explicitly constrain Chromium to the visible content rectangle. This is
    // also the allocation boundary: never let page/scroll geometry choose a
    // native bitmap size on Atom's behalf.
    const { normalized, visualSha256 } = await captureNormalizedApplicationImage(win, bounds);
    const jpeg = normalized.toJPEG(82);
    if (jpeg.length === 0 || jpeg.length > MAX_SCREENSHOT_JPEG_BYTES) {
      throw new Error('Atomizer screenshot JPEG exceeded the bounded Agent image payload');
    }
    const finalFocus = await this.#activeTarget(win);
    const finalBounds = win.getContentBounds();
    if (finalBounds.width !== bounds.width || finalBounds.height !== bounds.height) {
      throw new Error('Atomizer window geometry changed during the screenshot; capture a fresh screenshot');
    }
    const finalScaleFactor = this.#displayScaleFactor(finalBounds);
    assertSafeScreenshotBackingSize(finalBounds, finalScaleFactor);
    if (finalScaleFactor !== captureScaleFactor) {
      throw new Error('Atomizer display scale changed during the screenshot; capture a fresh screenshot');
    }
    if (finalFocus.target !== focus.target || finalFocus.editable !== focus.editable || finalFocus.blockedReason !== focus.blockedReason) {
      throw new Error('Atomizer focus changed during the screenshot; capture a fresh screenshot');
    }
    const screenshotId = randomUUID();
    const capturedAt = new Date().toISOString();
    this.#screenshotGrants.set(win, { screenshotId, width: bounds.width, height: bounds.height, scaleFactor: finalScaleFactor, visualSha256, expiresAt: Date.now() + SCREENSHOT_GRANT_MILLISECONDS });
    this.#issueFocusGrant(win, finalFocus.target);
    return {
      kind: 'atomizer-screenshot', screenshotId,
      imageDataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
      width: bounds.width, height: bounds.height, capturedAt, focusedTarget: focus.target,
    };
  }

  async click(win: BrowserWindow, screenshotId: string, x: number, y: number): Promise<AppComputerResult> {
    const grant = this.#consumeScreenshot(win, screenshotId);
    this.#point(win, x, y);
    const markerToken = randomUUID();
    const script = `(()=>{${RENDERER_TARGET_HELPERS}if(!rendererGeometryMatches(${grant.width},${grant.height},${grant.scaleFactor}))return {ok:false,action:'click',reason:'Atomizer window geometry or display scale changed after the screenshot'};const selector='button,input,select,textarea,a,[role="button"],[data-agent-control]';const leaf=document.elementFromPoint(${x},${y});if(!leaf)return {ok:false,action:'click',reason:'No target at coordinates'};const target=leaf.closest(selector);if(!target)return {ok:false,action:'click',reason:'Target is not an interactive Atomizer control'};const excluded=leaf.closest('[data-agent-exclusion]');if(excluded)return {ok:false,action:'click',target:String(excluded.getAttribute('data-agent-control')||excluded.getAttribute('aria-label')||excluded.tagName).slice(0,128),reason:'This control is a local human-only boundary'};const risky=leaf.closest('[data-agent-risk="high-impact"]');if(risky)return {ok:false,action:'click',target:String(risky.getAttribute('data-agent-control')||risky.getAttribute('aria-label')||risky.tagName).slice(0,128),reason:'High-impact controls require the typed approval tool'};if(controlIsDisabled(leaf)||controlIsDisabled(target))return {ok:false,action:'click',target:String(target.getAttribute('data-agent-control')||target.getAttribute('aria-label')||target.tagName).slice(0,128),reason:'Target is disabled'};const controlId=target.getAttribute('data-agent-control')||'';target.focus();const focusedLeaf=document.elementFromPoint(${x},${y});if(!target.isConnected||focusedLeaf?.closest(selector)!==target)return {ok:false,action:'click',target:controlId||String(target.tagName).slice(0,128),reason:'Coordinate target changed while preparing the click; capture a fresh screenshot'};const preparedBoundary=focusedLeaf.closest('[data-agent-exclusion],[data-agent-risk="high-impact"]');if(preparedBoundary)return {ok:false,action:'click',target:controlId||String(preparedBoundary.getAttribute('aria-label')||preparedBoundary.tagName).slice(0,128),reason:'Coordinate target became protected while preparing the click'};if(controlIsDisabled(focusedLeaf)||controlIsDisabled(target))return {ok:false,action:'click',target:controlId||String(target.tagName).slice(0,128),reason:'Target became disabled while preparing the click'};if(controlId==='spectrum.marker-place'){const bounds=target.getBoundingClientRect();if(!Number.isFinite(bounds.width)||!Number.isFinite(bounds.height)||bounds.width<=0||bounds.height<=0||${x}<bounds.left||${x}>bounds.right||${y}<bounds.top||${y}>bounds.bottom)return {ok:false,action:'click',target:controlId,reason:'Marker coordinate is outside the measured spectrum plot'};if(typeof PointerEvent!=='function')return {ok:false,action:'click',target:controlId,reason:'Coordinate-bearing pointer events are unavailable'};const markerEvent=new PointerEvent('pointerdown',{bubbles:true,cancelable:true,clientX:${x},clientY:${y},pointerId:1,pointerType:'mouse',isPrimary:true,button:0,buttons:1});Object.defineProperty(markerEvent,'__tinysaAtomMarkerRequestV1',{value:{token:${JSON.stringify(markerToken)}},enumerable:false,configurable:false,writable:false});target.dispatchEvent(markerEvent);const acknowledgement=markerEvent['__tinysaAtomMarkerResultV1'];if(!acknowledgement||acknowledgement.token!==${JSON.stringify(markerToken)}||acknowledgement.accepted!==true||!Number.isSafeInteger(acknowledgement.frequencyHz)||acknowledgement.frequencyHz<0)return {ok:false,action:'click',target:controlId,reason:'Marker placement was not acknowledged by the renderer'};const focus=inspectActiveTarget();return {ok:true,action:'click',target:controlId,markerFrequencyHz:acknowledgement.frequencyHz,focusGrantBlocked:true};}target.click();const focus=inspectActiveTarget();return {ok:true,action:'click',target:focus.target,focusGrantBlocked:Boolean(focus.blockedReason)};})()`;
    // Keep the same normalization stylesheet installed from the exact bitmap
    // recapture through renderer dispatch. Removing it before the action would
    // restart transitions/animations and reopen a visual-to-target race.
    const result = await this.#withScreenshotVisualState(win, grant, async () =>
      await win.webContents.executeJavaScript(script, true) as RendererComputerResult);
    if (result.ok) {
      if (result.target && !result.focusGrantBlocked) this.#issueFocusGrant(win, result.target);
      else this.#focusGrants.delete(win);
    }
    return publicComputerResult(result);
  }

  async type(win: BrowserWindow, expectedTarget: string, text: string): Promise<AppComputerResult> {
    if (!text || text.length > 2_000) throw new Error('Computer text must be 1–2000 characters');
    this.#consumeFocusGrant(win, expectedTarget);
    return this.#guardedNativeInput(win, { action: 'type', expectedTarget, requireEditable: true, text }, () => win.webContents.insertText(text));
  }

  async key(win: BrowserWindow, expectedTarget: string, key: string): Promise<AppComputerResult> {
    const allowed: Record<string, { keyCode: string; domKey: string; modifiers?: Array<'control' | 'meta'>; metaKey?: boolean; ctrlKey?: boolean }> = {
      ENTER: { keyCode: 'Enter', domKey: 'Enter' }, ESCAPE: { keyCode: 'Escape', domKey: 'Escape' }, TAB: { keyCode: 'Tab', domKey: 'Tab' },
      ARROWUP: { keyCode: 'Up', domKey: 'ArrowUp' }, ARROWDOWN: { keyCode: 'Down', domKey: 'ArrowDown' }, ARROWLEFT: { keyCode: 'Left', domKey: 'ArrowLeft' }, ARROWRIGHT: { keyCode: 'Right', domKey: 'ArrowRight' },
      BACKSPACE: { keyCode: 'Backspace', domKey: 'Backspace' }, 'META+K': { keyCode: 'k', domKey: 'k', modifiers: ['meta'], metaKey: true }, 'CTRL+K': { keyCode: 'k', domKey: 'k', modifiers: ['control'], ctrlKey: true },
    };
    const value = allowed[key];
    if (!value) throw new Error('Computer key is not allow-listed');
    this.#consumeFocusGrant(win, expectedTarget);
    return this.#guardedNativeInput(win, { action: 'key', expectedTarget, domKey: value.domKey, metaKey: value.metaKey, ctrlKey: value.ctrlKey }, () => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: value.keyCode, modifiers: value.modifiers });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: value.keyCode, modifiers: value.modifiers });
    });
  }

  async scroll(win: BrowserWindow, screenshotId: string, x: number, y: number, deltaX: number, deltaY: number): Promise<AppComputerResult> {
    const grant = this.#consumeScreenshot(win, screenshotId);
    this.#point(win, x, y);
    return this.#withScreenshotVisualState(win, grant, async () =>
      await this.#guardedNativeInput(win, { action: 'scroll', x, y, width: grant.width, height: grant.height, scaleFactor: grant.scaleFactor, deltaX, deltaY }, () => {
        // The renderer hit-test above crosses a process boundary. Revalidate the
        // exact native geometry and scale immediately before wheel injection.
        this.#assertScreenshotEnvironment(win, grant);
        this.#point(win, x, y);
        win.webContents.sendInputEvent({ type: 'mouseWheel', x, y, deltaX, deltaY, canScroll: true });
      }));
  }

  async #guardedNativeInput(win: BrowserWindow, input: GuardedNativeInput, inject: () => void): Promise<AppComputerResult> {
    const token = randomUUID();
    const arm = await win.webContents.executeJavaScript(nativeInputArmScript(this.#rendererGuardNamespace, token, input), true) as RendererComputerResult;
    if (!arm.ok || !arm.armed) return publicComputerResult(arm);
    try {
      inject();
    } catch (error) {
      await this.#cancelNativeInputGuard(win, token, input.action);
      throw error;
    }
    let result: AppComputerResult;
    try {
      result = await win.webContents.executeJavaScript(nativeInputWaitScript(this.#rendererGuardNamespace, token, input.action), true) as AppComputerResult;
    } catch (error) {
      await this.#cancelNativeInputGuard(win, token, input.action);
      throw error;
    }
    if (result.ok && result.target && input.action !== 'scroll') this.#issueFocusGrant(win, result.target);
    return result;
  }

  async #cancelNativeInputGuard(win: BrowserWindow, token: string, action: GuardedNativeInput['action']): Promise<void> {
    try {
      await win.webContents.executeJavaScript(nativeInputCancelScript(this.#rendererGuardNamespace, token, action), true);
    } catch {
      // A renderer teardown also destroys its guard store. Preserve the
      // original native-injection/wait error instead of replacing it here.
    }
  }

  async #activeTarget(win: BrowserWindow): Promise<ActiveTarget> {
    return await win.webContents.executeJavaScript(`(()=>{const e=document.activeElement;if(!e||e===document.body||e===document.documentElement)return {target:'APPLICATION',editable:false};const control=e.closest?.('[data-agent-control]');const boundary=e.closest?.('[data-agent-exclusion],[data-agent-risk="high-impact"]');const target=(control?.getAttribute('data-agent-control')||e.getAttribute?.('data-agent-control')||e.getAttribute?.('aria-label')||e.tagName||'APPLICATION').slice(0,128);const editable=['INPUT','TEXTAREA'].includes(e.tagName)||e.isContentEditable;return boundary?{target,editable,blockedReason:'Focused control is a local human-only or high-impact boundary'}:{target,editable};})()`, true) as ActiveTarget;
  }

  #consumeScreenshot(win: BrowserWindow, screenshotId: string): ScreenshotGrant {
    const grant = this.#screenshotGrants.get(win);
    this.#screenshotGrants.delete(win);
    if (!grant || grant.screenshotId !== screenshotId) throw new Error('Computer coordinate action requires the latest unconsumed Atomizer screenshot ID');
    if (Date.now() > grant.expiresAt) throw new Error('Computer screenshot expired; capture a fresh Atomizer screenshot');
    this.#assertScreenshotEnvironment(win, grant);
    return grant;
  }

  #assertScreenshotEnvironment(win: BrowserWindow, grant: ScreenshotGrant): void {
    const bounds = win.getContentBounds();
    if (bounds.width !== grant.width || bounds.height !== grant.height) throw new Error('Atomizer window geometry changed after the screenshot; capture a fresh screenshot');
    const scaleFactor = this.#displayScaleFactor(bounds);
    assertSafeScreenshotBackingSize(bounds, scaleFactor);
    if (scaleFactor !== grant.scaleFactor) throw new Error('Atomizer display scale changed after the screenshot; capture a fresh screenshot');
  }

  async #withScreenshotVisualState<T>(win: BrowserWindow, grant: ScreenshotGrant, action: () => Promise<T>): Promise<T> {
    this.#assertScreenshotEnvironment(win, grant);
    const bounds = win.getContentBounds();
    return await withNormalizedApplicationImage(win, bounds, async ({ visualSha256 }) => {
      this.#assertScreenshotEnvironment(win, grant);
      if (visualSha256 !== grant.visualSha256) {
        throw new Error('Atomizer visual state changed after the screenshot; capture a fresh screenshot');
      }
      return await action();
    });
  }

  #issueFocusGrant(win: BrowserWindow, target: string): void {
    this.#focusGrants.set(win, { target, expiresAt: Date.now() + SCREENSHOT_GRANT_MILLISECONDS });
  }

  #consumeFocusGrant(win: BrowserWindow, expectedTarget: string): void {
    const grant = this.#focusGrants.get(win);
    this.#focusGrants.delete(win);
    if (!grant) throw new Error('Computer focus action requires a trusted target from the latest screenshot or successful computer action');
    if (Date.now() > grant.expiresAt) throw new Error('Computer focus evidence expired; capture a fresh screenshot');
    if (grant.target !== expectedTarget) throw new Error('Computer focus action target does not match the latest trusted focus evidence');
  }

  #point(win: BrowserWindow, x: number, y: number): void {
    const bounds = win.getContentBounds();
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) throw new Error('Computer coordinates are outside the Atomizer window');
  }
}

async function captureNormalizedApplicationImage(
  win: BrowserWindow,
  bounds: Pick<Rectangle, 'width' | 'height'>,
): Promise<{ normalized: NativeImage; visualSha256: string }> {
  return await withNormalizedApplicationImage(win, bounds, async (capture) => capture);
}

async function withNormalizedApplicationImage<T>(
  win: BrowserWindow,
  bounds: Pick<Rectangle, 'width' | 'height'>,
  use: (capture: { normalized: NativeImage; visualSha256: string }) => Promise<T>,
): Promise<T> {
  const cssKey = await win.webContents.insertCSS(SCREENSHOT_NORMALIZATION_CSS, { cssOrigin: 'user' });
  try {
    const image = await win.webContents.capturePage({ x: 0, y: 0, width: bounds.width, height: bounds.height });
    if (image.isEmpty()) throw new Error('Atomizer screenshot capture returned an empty image');
    const capturedSize = image.getSize();
    assertSafeScreenshotSize('captured image', capturedSize);
    const normalized = capturedSize.width === bounds.width && capturedSize.height === bounds.height
      ? image
      : image.resize({ width: bounds.width, height: bounds.height, quality: 'good' });
    const normalizedSize = normalized.getSize();
    assertSafeScreenshotSize('normalized image', normalizedSize);
    if (normalizedSize.width !== bounds.width || normalizedSize.height !== bounds.height) {
      throw new Error('Atomizer screenshot normalization returned unexpected dimensions');
    }
    const bitmap = normalized.toBitmap({ scaleFactor: 1 });
    const expectedBitmapBytes = normalizedSize.width * normalizedSize.height * 4;
    if (bitmap.length !== expectedBitmapBytes || bitmap.length > MAX_SCREENSHOT_PIXELS * 4) {
      throw new Error('Atomizer screenshot bitmap did not match the bounded visual-state comparison payload');
    }
    return await use({
      normalized,
      visualSha256: createHash('sha256').update(bitmap).digest('hex'),
    });
  } finally {
    await win.webContents.removeInsertedCSS(cssKey);
  }
}

function nativeInputArmScript(namespace: string, token: string, input: GuardedNativeInput): string {
  const action = JSON.stringify(input.action);
  const expectedTarget = JSON.stringify(input.expectedTarget ?? '');
  const coordinateTarget = JSON.stringify(`${input.x ?? 0},${input.y ?? 0}`);
  const preflight = input.action === 'scroll'
    ? `if(!rendererGeometryMatches(${input.width},${input.height},${input.scaleFactor}))return {ok:false,action,target:${coordinateTarget},reason:'Atomizer window geometry or display scale changed after the screenshot'};const boundary=coordinateBoundary(${input.x},${input.y});if(boundary.blockedReason)return {ok:false,action,target:boundary.target,reason:boundary.blockedReason};`
    : `const current=inspectActiveTarget();if(current.blockedReason)return {ok:false,action,target:current.target,reason:current.blockedReason};if(current.target!==expectedTarget)return {ok:false,action,target:current.target,reason:'Focused target changed; capture a fresh screenshot'};${input.requireEditable ? "if(!current.editable)return {ok:false,action,target:current.target,reason:'Focused Atomizer control is not editable'};" : ''}`;
  const eventName = input.action === 'type' ? 'beforeinput' : input.action === 'key' ? 'keydown' : 'wheel';
  const unexpectedInputTarget = input.action === 'scroll' ? coordinateTarget : 'expectedTarget';
  const eventMatch = input.action === 'type'
    ? `if(!(event instanceof InputEvent))return;if(event.inputType!=='insertText'||event.data!==${JSON.stringify(input.text ?? '')}){block(event,{ok:false,action,target:${unexpectedInputTarget},reason:'Native input did not match the armed type action'});return;}`
    : input.action === 'key'
      ? `if(!(event instanceof KeyboardEvent))return;if(event.key!==${JSON.stringify(input.domKey ?? '')}||event.metaKey!==${Boolean(input.metaKey)}||event.ctrlKey!==${Boolean(input.ctrlKey)}||event.altKey||event.shiftKey){block(event,{ok:false,action,target:${unexpectedInputTarget},reason:'Native input did not match the armed key action'});return;}`
      : `if(!(event instanceof WheelEvent))return;if(Math.round(event.clientX)!==${input.x}||Math.round(event.clientY)!==${input.y}||Math.round(event.deltaX)!==${input.deltaX}||Math.round(event.deltaY)!==${input.deltaY}){block(event,{ok:false,action,target:${unexpectedInputTarget},reason:'Native input did not match the armed scroll action'});return;}`;
  const deliveryValidation = input.action === 'scroll'
    ? `if(!rendererGeometryMatches(${input.width},${input.height},${input.scaleFactor})){block(event,{ok:false,action,target:${coordinateTarget},reason:'Atomizer window geometry or display scale changed before native input delivery'});return;}const deliveredBoundary=coordinateBoundary(${input.x},${input.y});if(deliveredBoundary.blockedReason){block(event,{ok:false,action,target:deliveredBoundary.target,reason:deliveredBoundary.blockedReason});return;}finish({ok:true,action,target:${coordinateTarget}});`
    : `const delivered=inspectActiveTarget();if(delivered.blockedReason){block(event,{ok:false,action,target:delivered.target,reason:delivered.blockedReason});return;}if(delivered.target!==expectedTarget){block(event,{ok:false,action,target:delivered.target,reason:'Focused target changed immediately before native input delivery'});return;}${input.requireEditable ? "if(!delivered.editable){block(event,{ok:false,action,target:delivered.target,reason:'Focused Atomizer control is not editable'});return;}" : ''}finish({ok:true,action,target:delivered.target});`;
  return `(()=>{${RENDERER_TARGET_HELPERS}const action=${action};const expectedTarget=${expectedTarget};${preflight}const root=globalThis;const namespace=${JSON.stringify(namespace)};let store=root[namespace];if(!(store instanceof Map)){store=new Map();Object.defineProperty(root,namespace,{value:store,configurable:true});}const token=${JSON.stringify(token)};let completed=false;let result;let expiryTimer;let disposalTimer;const waiters=new Set();const dispose=()=>{store.delete(token);if(store.size===0)delete root[namespace];};const stopListening=()=>{window.removeEventListener(${JSON.stringify(eventName)},onInput,true);if(expiryTimer)clearTimeout(expiryTimer);};const finish=(value)=>{if(completed)return;completed=true;result=value;stopListening();for(const deliver of waiters)deliver(value);const hadWaiters=waiters.size>0;waiters.clear();if(hadWaiters)dispose();else disposalTimer=setTimeout(dispose,${NATIVE_INPUT_WAIT_MILLISECONDS});};const block=(event,value)=>{if(event.cancelable)event.preventDefault();event.stopImmediatePropagation();event.stopPropagation();finish(value);};const onInput=(event)=>{${eventMatch}${deliveryValidation}};const cancel=()=>{finish({ok:false,action,target:${input.action === 'scroll' ? coordinateTarget : 'expectedTarget'},reason:'Native input guard was cancelled before verified delivery'});if(disposalTimer)clearTimeout(disposalTimer);dispose();};const record={cancel,wait:()=>{if(completed){const value=result;if(disposalTimer)clearTimeout(disposalTimer);dispose();return Promise.resolve(value);}return new Promise(resolve=>{let deliver;const timer=setTimeout(()=>{waiters.delete(deliver);const timeoutResult={ok:false,action,target:${input.action === 'scroll' ? coordinateTarget : 'expectedTarget'},reason:'Native input was not observed before the bounded guard deadline'};finish(timeoutResult);if(disposalTimer)clearTimeout(disposalTimer);dispose();resolve(timeoutResult);},${NATIVE_INPUT_WAIT_MILLISECONDS});deliver=(value)=>{clearTimeout(timer);resolve(value);};waiters.add(deliver);});}};store.set(token,record);window.addEventListener(${JSON.stringify(eventName)},onInput,true);expiryTimer=setTimeout(()=>finish({ok:false,action,target:${input.action === 'scroll' ? coordinateTarget : 'expectedTarget'},reason:'Native input guard expired before delivery'}),${NATIVE_INPUT_GUARD_MILLISECONDS});return {ok:true,action,target:${input.action === 'scroll' ? coordinateTarget : 'expectedTarget'},armed:true};})()`;
}

function nativeInputWaitScript(namespace: string, token: string, action: GuardedNativeInput['action']): string {
  return `(async()=>{const store=globalThis[${JSON.stringify(namespace)}];const record=store instanceof Map?store.get(${JSON.stringify(token)}):undefined;if(!record||typeof record.wait!=='function')return {ok:false,action:${JSON.stringify(action)},reason:'Native input guard was unavailable at delivery'};return await record.wait();})()`;
}

function nativeInputCancelScript(namespace: string, token: string, action: GuardedNativeInput['action']): string {
  return `(()=>{const store=globalThis[${JSON.stringify(namespace)}];const record=store instanceof Map?store.get(${JSON.stringify(token)}):undefined;if(!record||typeof record.cancel!=='function')return {ok:false,action:${JSON.stringify(action)},reason:'Native input guard was unavailable during cancellation'};record.cancel();return {ok:true,action:${JSON.stringify(action)}};})()`;
}

function publicComputerResult(result: RendererComputerResult): AppComputerResult {
  return { ok: result.ok, action: result.action, ...(result.target ? { target: result.target } : {}), ...(result.reason ? { reason: result.reason } : {}) };
}

function assertSafeScreenshotSize(label: string, size: { width: number; height: number }): void {
  if (!Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height)
    || size.width <= 0 || size.height <= 0
    || size.width > MAX_SCREENSHOT_DIMENSION || size.height > MAX_SCREENSHOT_DIMENSION
    || size.width * size.height > MAX_SCREENSHOT_PIXELS) {
    throw new Error(`Atomizer ${label} dimensions are outside the bounded screenshot allocation`);
  }
}

function assertSafeScreenshotBackingSize(bounds: { width: number; height: number }, scaleFactor: number): void {
  if (typeof scaleFactor !== 'number' || !Number.isFinite(scaleFactor) || scaleFactor <= 0) {
    throw new Error('Atomizer display scale factor is outside the bounded screenshot allocation');
  }
  assertSafeScreenshotSize('application content backing image', {
    width: Math.ceil(bounds.width * scaleFactor),
    height: Math.ceil(bounds.height * scaleFactor),
  });
}
