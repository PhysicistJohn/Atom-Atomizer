import { describe, expect, it, vi } from 'vitest';
import { AppComputerHarness } from './app-computer.js';

function fakeWindow(){
  const normalized={toJPEG:vi.fn().mockReturnValue(Buffer.from('image'))};
  const image={resize:vi.fn().mockReturnValue(normalized)};
  const webContents={capturePage:vi.fn().mockResolvedValue(image),executeJavaScript:vi.fn().mockResolvedValue({ok:false,action:'click',reason:'High-impact controls require the typed approval tool'}),insertText:vi.fn(),sendInputEvent:vi.fn()};
  return {win:{getContentBounds:()=>({x:0,y:0,width:1200,height:800}),webContents},webContents,image,normalized};
}

describe('app-scoped computer harness',()=>{
  it('captures and normalizes only the application content',async()=>{
    const {win,image}=fakeWindow();const shot=await new AppComputerHarness().screenshot(win as never);
    expect(image.resize).toHaveBeenCalledWith({width:1200,height:800,quality:'good'});expect(shot.imageDataUrl).toMatch(/^data:image\/jpeg;base64,/);
  });
  it('bounds coordinates and retains the high-impact DOM guard',async()=>{
    const {win,webContents}=fakeWindow();const harness=new AppComputerHarness();
    await expect(harness.click(win as never,1200,20)).rejects.toThrow(/outside/);
    const result=await harness.click(win as never,10,20);expect(result.ok).toBe(false);
    expect(String(webContents.executeJavaScript.mock.calls[0]?.[0])).toContain('data-agent-risk');
    expect(String(webContents.executeJavaScript.mock.calls[0]?.[0])).toContain('data-agent-exclusion');
  });
  it('allows only declared keys',async()=>{
    const {win,webContents}=fakeWindow();const harness=new AppComputerHarness();
    await expect(harness.key(win as never,'DELETE')).rejects.toThrow(/allow-listed/);await harness.key(win as never,'ENTER');expect(webContents.sendInputEvent).toHaveBeenCalledTimes(2);
  });
  it('blocks click, type, key, and scroll paths at local human-only boundaries',async()=>{
    const {win,webContents}=fakeWindow();const harness=new AppComputerHarness();
    webContents.executeJavaScript.mockResolvedValueOnce({ok:false,action:'click',target:'firmware.flash',reason:'local human-only boundary'});
    expect(await harness.click(win as never,10,20)).toMatchObject({ok:false,target:'firmware.flash'});
    webContents.executeJavaScript.mockResolvedValue({target:'firmware.flash',blockedReason:'local human-only boundary'});
    expect(await harness.type(win as never,'FLASH')).toMatchObject({ok:false,target:'firmware.flash'});
    expect(await harness.key(win as never,'ENTER')).toMatchObject({ok:false,target:'firmware.flash'});
    expect(await harness.scroll(win as never,10,20,0,100)).toMatchObject({ok:false,target:'firmware.flash'});
    expect(webContents.insertText).not.toHaveBeenCalled();
    expect(webContents.sendInputEvent).not.toHaveBeenCalled();
  });
});
