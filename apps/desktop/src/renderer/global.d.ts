import type { AtomizerFilesApiV1, AtomizerInstrumentApiV1 } from '@tinysa/contracts';
import type { AgentStatus, AgentTurnRequest, AgentTurnResult } from '@tinysa/agent';
declare global { interface Window {
  atomizerInstrument: AtomizerInstrumentApiV1;
  atomizerFiles: AtomizerFilesApiV1;
  atomAgent: { status():Promise<AgentStatus>; createRealtimeCall(sdp:string):Promise<string>; agentTurn(request:AgentTurnRequest):Promise<AgentTurnResult>;
    computerScreenshot():Promise<{kind:'atomizer-screenshot';screenshotId:string;imageDataUrl:string;width:number;height:number;capturedAt:string;focusedTarget:string}>;
    computerClick(value:{screenshotId:string;x:number;y:number}):Promise<{ok:boolean;action:string;target?:string;reason?:string}>;
    computerType(value:{expectedTarget:string;text:string}):Promise<{ok:boolean;action:string;target?:string;reason?:string}>;
    computerKey(value:{expectedTarget:string;key:string}):Promise<{ok:boolean;action:string;target?:string;reason?:string}>;
    computerScroll(value:{screenshotId:string;x:number;y:number;deltaX:number;deltaY:number}):Promise<{ok:boolean;action:string;target?:string;reason?:string}>;
  };
} }
export {};
