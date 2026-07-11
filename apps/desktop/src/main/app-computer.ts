import type { BrowserWindow } from 'electron';

export interface AppScreenshot { kind:'tinysa-atomizer-screenshot';imageDataUrl:string;width:number;height:number;capturedAt:string; }
export interface AppComputerResult { ok:boolean;action:string;target?:string;reason?:string; }

export class AppComputerHarness {
  async screenshot(win:BrowserWindow):Promise<AppScreenshot>{
    const bounds=win.getContentBounds();const image=await win.webContents.capturePage();
    const normalized=image.resize({width:bounds.width,height:bounds.height,quality:'good'});const jpeg=normalized.toJPEG(82);
    return {kind:'tinysa-atomizer-screenshot',imageDataUrl:`data:image/jpeg;base64,${jpeg.toString('base64')}`,width:bounds.width,height:bounds.height,capturedAt:new Date().toISOString()};
  }
  async click(win:BrowserWindow,x:number,y:number):Promise<AppComputerResult>{
    this.#point(win,x,y);
    const script=`(()=>{const leaf=document.elementFromPoint(${x},${y});if(!leaf)return {ok:false,action:'click',reason:'No target at coordinates'};const target=leaf.closest('button,input,select,textarea,a,[role="button"],[data-agent-control]');if(!target)return {ok:false,action:'click',reason:'Target is not an interactive TinySA Atomizer control'};const risky=target.closest('[data-agent-risk="high-impact"]');if(risky)return {ok:false,action:'click',target:risky.getAttribute('data-agent-control')||risky.tagName,reason:'High-impact controls require the typed approval tool'};if(target.disabled||target.getAttribute('aria-disabled')==='true')return {ok:false,action:'click',reason:'Target is disabled'};target.focus();target.click();return {ok:true,action:'click',target:target.getAttribute('data-agent-control')||target.getAttribute('aria-label')||target.textContent?.trim().slice(0,80)||target.tagName};})()`;
    return await win.webContents.executeJavaScript(script,true) as AppComputerResult;
  }
  async type(win:BrowserWindow,text:string):Promise<AppComputerResult>{
    if(!text||text.length>2000)throw new Error('Computer text must be 1–2000 characters');
    const target=await win.webContents.executeJavaScript(`(()=>{const e=document.activeElement;if(!e||!['INPUT','TEXTAREA'].includes(e.tagName)&&!e.isContentEditable)return null;return e.getAttribute('data-agent-control')||e.getAttribute('aria-label')||e.tagName;})()`,true) as string|null;
    if(!target)return {ok:false,action:'type',reason:'No editable TinySA Atomizer control is focused'};
    win.webContents.insertText(text);return {ok:true,action:'type',target};
  }
  key(win:BrowserWindow,key:string):AppComputerResult{
    const allowed:Record<string,{keyCode:string;modifiers?:Array<'control'|'meta'>}>={ENTER:{keyCode:'Enter'},ESCAPE:{keyCode:'Escape'},TAB:{keyCode:'Tab'},ARROWUP:{keyCode:'Up'},ARROWDOWN:{keyCode:'Down'},ARROWLEFT:{keyCode:'Left'},ARROWRIGHT:{keyCode:'Right'},BACKSPACE:{keyCode:'Backspace'},'META+K':{keyCode:'k',modifiers:['meta']},'CTRL+K':{keyCode:'k',modifiers:['control']}};
    const value=allowed[key];if(!value)throw new Error('Computer key is not allow-listed');
    win.webContents.sendInputEvent({type:'keyDown',keyCode:value.keyCode,modifiers:value.modifiers});win.webContents.sendInputEvent({type:'keyUp',keyCode:value.keyCode,modifiers:value.modifiers});return {ok:true,action:'key',target:key};
  }
  scroll(win:BrowserWindow,x:number,y:number,deltaX:number,deltaY:number):AppComputerResult{
    this.#point(win,x,y);win.webContents.sendInputEvent({type:'mouseWheel',x,y,deltaX,deltaY,canScroll:true});return {ok:true,action:'scroll',target:`${x},${y}`};
  }
  #point(win:BrowserWindow,x:number,y:number){const bounds=win.getContentBounds();if(!Number.isInteger(x)||!Number.isInteger(y)||x<0||y<0||x>=bounds.width||y>=bounds.height)throw new Error('Computer coordinates are outside the TinySA Atomizer window');}
}
