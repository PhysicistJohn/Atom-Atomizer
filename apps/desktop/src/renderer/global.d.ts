import type { TinySaApiV2 } from '@tinysa/contracts';
import type { AgentStatus, AgentTurnRequest, AgentTurnResult } from '@tinysa/agent';
declare global { interface Window {
  tinySA: TinySaApiV2;
  atomAgent: { status():Promise<AgentStatus>; createRealtimeCall(sdp:string):Promise<string>; agentTurn(request:AgentTurnRequest):Promise<AgentTurnResult>;
    computerScreenshot():Promise<{kind:'tinysa-atomizer-screenshot';imageDataUrl:string;width:number;height:number;capturedAt:string}>;
    computerClick(point:{x:number;y:number}):Promise<{ok:boolean;action:string;target?:string;reason?:string}>;
    computerType(text:string):Promise<{ok:boolean;action:string;target?:string;reason?:string}>;
    computerKey(key:string):Promise<{ok:boolean;action:string;target?:string;reason?:string}>;
    computerScroll(value:{x:number;y:number;deltaX:number;deltaY:number}):Promise<{ok:boolean;action:string;target?:string;reason?:string}>;
  };
} }
export {};
