// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { AgentExecutor } from './agent-executor.js';
import { RendererKernel } from './controllers/kernel.js';
import { AtomizerStore, createInitialRendererState } from './store.js';

describe('agent classification results', () => {
  it('identifies the application-global rolling trend contract', async () => {
    const store = new AtomizerStore(createInitialRendererState({
      initialWorkspace: 'spectrum',
      initialAgentOpen: false,
    }));
    store.set({
      classification: {
        source: 'iq',
        pending: false,
        sampleCount: 21,
        result: {
          flavor: 'iq',
          family: 'ofdm',
          modulation: '64qam',
          confidence: 0.8,
          isUnknown: false,
          posterior: { ofdm: 0.8, dsss: 0.2 },
          candidates: [
            { label: 'ofdm', confidence: 0.8 },
            { label: 'dsss', confidence: 0.2 },
          ],
          bwFraction: 0.7,
        },
      },
    });

    const result = await new AgentExecutor(new RendererKernel(store)).classifyCurrentCapture();

    expect(result).toMatchObject({
      available: true,
      contract: 'rolling-modulation-classification-v1',
      projection: 'rolling-posterior-trend',
      windowMilliseconds: 500,
      sampleCount: 21,
      family: 'ofdm',
      modulation: '64qam',
    });
    expect(result).not.toHaveProperty('contract', 'capture-modulation-classification-v1');
  });
});
