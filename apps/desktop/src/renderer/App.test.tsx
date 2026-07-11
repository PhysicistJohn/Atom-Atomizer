// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceSnapshot, Sweep } from '@tinysa/contracts';
import { App } from './App.js';

const port = { id: 'sim', path: 'fake://zs407', manufacturer: 'tinySA simulator', serialNumber: 'SIM-407' };
const ready: DeviceSnapshot = { connection:'ready',mode:'idle',generatorOutput:'off',verification:'unknown',identity:{model:'tinySA ULTRA+ ZS407',firmwareVersion:'sim-1',port},capabilities:{analyzerFrequency:{min:100_000,max:7_300_000_000,unit:'Hz'},maxSweepPoints:450,screenCapture:true,remoteTouch:true,streaming:true,commands:['scan'],evidence:'simulated'} };
const sweep: Sweep = { id:'s1',capturedAt:'2026-07-10T00:00:00.000Z',frequencyHz:[88e6,98e6,108e6],powerDbm:[-90,-50,-89],requested:{startHz:88e6,stopHz:108e6,points:3,attenuationDb:'auto'},actualStartHz:88e6,actualStopHz:108e6,identity:ready.identity! };

afterEach(cleanup);

beforeEach(() => {
  window.tinySA = {
    version: 1,
    listDevices: vi.fn().mockResolvedValue([port]), connect: vi.fn().mockResolvedValue(ready), disconnect: vi.fn().mockResolvedValue(undefined),
    getSnapshot: vi.fn().mockResolvedValue(ready), configureAnalyzer: vi.fn().mockResolvedValue({ ...ready, mode:'analyzer' }), acquireSweep: vi.fn().mockResolvedValue(sweep),
    configureGenerator: vi.fn().mockResolvedValue({ ...ready, mode:'generator' }), setGeneratorOutput: vi.fn().mockResolvedValue({ ...ready, mode:'generator',generatorOutput:'on' })
  };
  window.atomAgent = {
    status: vi.fn().mockResolvedValue({configured:false,model:'gpt-realtime-2.1-mini',voice:'ballad',reasoningEffort:'high',textAgent:false,realtime:false,textTransport:'realtime-websocket'}),
    createRealtimeCall: vi.fn(), agentTurn: vi.fn(), computerScreenshot:vi.fn(),computerClick:vi.fn(),computerType:vi.fn(),computerKey:vi.fn(),computerScroll:vi.fn()
  };
});

describe('operator vertical slice', () => {
  it('renders the atomic instrument frame without dead navigation affordances', async () => {
    const { container }=render(<App/>);
    await waitFor(()=>expect(window.atomAgent.status).toHaveBeenCalledOnce());
    const navigation=screen.getByRole('navigation',{name:/Primary navigation/i});
    for(const label of ['Spectrum','Detect','Classify','Generate'])expect(navigation.textContent).toContain(label);
    expect(navigation.textContent).not.toContain('Remote screen');
    expect(navigation.textContent).not.toContain('Sessions');
    expect(navigation.textContent).not.toContain('Settings');
    expect(container.querySelector('.atomic-mark')).toBeTruthy();
    expect(container.querySelector('.acquisition-dock')).toBeTruthy();
    await waitFor(()=>expect(container.querySelector('.atom-foot')?.textContent).toContain('REASONING HIGH'));
    expect(container.querySelector('.atom-foot')?.textContent).toContain('VOICE BALLAD');
  });

  it('connects, configures, and acquires through the typed bridge', async () => {
    render(<App/>);
    await waitFor(()=>expect(window.tinySA.listDevices).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button',{name:/No instrument/i}));
    await screen.findByRole('dialog',{name:/USB connection/i});
    fireEvent.click(screen.getByRole('button',{name:/tinySA simulator/i}));
    fireEvent.click(screen.getByRole('button',{name:/Connect instrument/i}));
    await screen.findByText('tinySA ULTRA+ ZS407');
    fireEvent.click(screen.getByRole('button',{name:/Single sweep/i}));
    await waitFor(()=>expect(window.tinySA.acquireSweep).toHaveBeenCalledOnce());
    expect(await screen.findByLabelText('Measured power by frequency')).toBeTruthy();
    expect(window.tinySA.configureAnalyzer).toHaveBeenCalledBefore(vi.mocked(window.tinySA.acquireSweep));
  });

  it('lets Atom list, connect, verify, and acquire through typed tools', async () => {
    vi.mocked(window.atomAgent.status).mockResolvedValue({configured:true,model:'gpt-realtime-2.1-mini',voice:'ballad',reasoningEffort:'high',textAgent:true,realtime:true,textTransport:'realtime-websocket'});
    vi.mocked(window.atomAgent.agentTurn)
      .mockResolvedValueOnce({conversationId:'r1',transport:'realtime-websocket',text:'',toolCalls:[{callId:'c1',name:'list_connection_candidates',arguments:'{}'}]})
      .mockResolvedValueOnce({conversationId:'r2',transport:'realtime-websocket',text:'',toolCalls:[{callId:'c2',name:'connect_device',arguments:'{"candidateId":"candidate-1"}'}]})
      .mockResolvedValueOnce({conversationId:'r3',transport:'realtime-websocket',text:'',toolCalls:[{callId:'c3',name:'get_instrument_state',arguments:'{}'}]})
      .mockResolvedValueOnce({conversationId:'r4',transport:'realtime-websocket',text:'',toolCalls:[{callId:'c4',name:'acquire_sweep',arguments:'{}'}]})
      .mockResolvedValueOnce({conversationId:'r5',transport:'realtime-websocket',text:'Sweep complete.',toolCalls:[]});

    render(<App/>);
    await waitFor(()=>expect(window.tinySA.listDevices).toHaveBeenCalledOnce());
    const composer=await screen.findByPlaceholderText(/Ask Atom/i);
    fireEvent.change(composer,{target:{value:'Connect the simulator and acquire one sweep.'}});
    fireEvent.click(screen.getByRole('button',{name:/Send to Atom/i}));

    await waitFor(()=>expect(window.tinySA.connect).toHaveBeenCalledWith(port));
    await waitFor(()=>expect(window.tinySA.acquireSweep).toHaveBeenCalledOnce());
    expect(await screen.findByText('Sweep complete.')).toBeTruthy();
    const candidateOutput=vi.mocked(window.atomAgent.agentTurn).mock.calls[1]?.[0].toolOutputs?.[0]?.output??'';
    expect(candidateOutput).toContain('candidate-1');
    expect(candidateOutput).not.toContain('fake://');
    expect(candidateOutput).not.toContain('SIM-407');
  });
});
