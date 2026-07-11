import { describe, expect, it } from 'vitest';
import type { PortCandidate } from '@tinysa/contracts';
import { FakeTinySaTransport } from '@tinysa/test-device';
import { TinySaDeviceService } from './device.js';
import type { ByteTransport, TransportEvent } from './transport.js';

describe('device fail-loud lifecycle',()=>{
  it('reports RF-off failure during disconnect and enters faulted/unknown state',async()=>{
    const transport=new FailSecondOutputOffTransport();
    const service=new TinySaDeviceService(transport);
    await service.connect(transport.port);
    await service.configureGenerator({frequencyHz:100_000_000,levelDbm:-30,modulation:'off'});
    await service.setGeneratorOutput(true);

    await expect(service.disconnect()).rejects.toThrow(/forced output-off failure/);
    expect(service.snapshot()).toMatchObject({connection:'faulted',generatorOutput:'unknown',verification:'stale'});
  });
});

class FailSecondOutputOffTransport implements ByteTransport {
  readonly #inner=new FakeTinySaTransport();
  #outputOffCount=0;
  get port():PortCandidate{return this.#inner.port;}
  list():Promise<PortCandidate[]>{return this.#inner.list();}
  open(candidate:PortCandidate):Promise<void>{return this.#inner.open(candidate);}
  close():Promise<void>{return this.#inner.close();}
  async write(bytes:Uint8Array):Promise<void>{
    const command=new TextDecoder().decode(bytes).trim();
    if(command==='output off'&&++this.#outputOffCount===2)throw new Error('forced output-off failure');
    await this.#inner.write(bytes);
  }
  onBytes(listener:(bytes:Uint8Array)=>void):()=>void{return this.#inner.onBytes(listener);}
  onEvent(listener:(event:TransportEvent)=>void):()=>void{return this.#inner.onEvent(listener);}
}
