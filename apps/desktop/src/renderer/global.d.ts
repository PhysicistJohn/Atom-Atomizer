import type { AtomizerFilesApiV1, AtomizerInstrumentApiV1 } from '@tinysa/contracts';
import type { AgentStatus, AgentTurnRequest, AgentTurnResult } from '@tinysa/agent';
/** App-private Electron bridge extension; it is not an instrument contract capability. */
type AtomizerManualEndpointResult = { ok: true } | { ok: false; message: string };
type AtomizerRendererInstrumentApi = AtomizerInstrumentApiV1 & {
  /** Available only when this product edition has a driver-backed address bootstrap. */
  addManualEndpoint?(endpoint: string): Promise<AtomizerManualEndpointResult>;
};
declare global { interface Window {
  atomizerInstrument: AtomizerRendererInstrumentApi;
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
