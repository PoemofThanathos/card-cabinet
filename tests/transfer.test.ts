import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  setDoc: vi.fn(async () => {}),
  deleteDoc: vi.fn(async () => {}),
  auth: { currentUser: { uid: 'owner' } },
  onSnapshot: vi.fn(() => () => {}),
}));
vi.mock('../src/firebase', () => ({ auth: mocks.auth, firestore: {} }));
vi.mock('firebase/firestore', () => ({
  doc: (_fs: unknown, ...parts: string[]) => parts.join('/'),
  setDoc: mocks.setDoc,
  deleteDoc: mocks.deleteDoc,
  onSnapshot: mocks.onSnapshot,
  Timestamp: { fromMillis: (n: number) => ({ toMillis: () => n }) },
  getDocFromServer: vi.fn(),
  runTransaction: vi.fn(),
}));
import { PhotoTransfer } from '../src/transfer';
import { photoHash } from '../src/db';
class Channel {
  readyState = 'open';
  bufferedAmount = 0;
  binaryType = '';
  bufferedAmountLowThreshold = 0;
  messages: unknown[] = [];
  onmessage?: (e: { data: unknown }) => void;
  onopen?: () => void;
  onerror?: () => void;
  send(data: unknown) {
    this.messages.push(data);
  }
  close() {
    this.readyState = 'closed';
  }
  addEventListener() {}
  removeEventListener() {}
}
let channel: Channel;
class Peer {
  iceGatheringState = 'complete';
  localDescription = { sdp: 'test SDP' };
  connectionState = 'connected';
  ondatachannel?: unknown;
  onconnectionstatechange?: unknown;
  createDataChannel() {
    channel = new Channel();
    return channel;
  }
  async setLocalDescription() {}
  async createOffer() {
    return { type: 'offer', sdp: 'test' };
  }
  async setRemoteDescription() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});
describe('direct transfer protocol with mocked signaling', () => {
  it('creates an unguessable owner-scoped, expiring pairing without photo data', async () => {
    vi.stubGlobal('RTCPeerConnection', Peer);
    const transfer = new PhotoTransfer(vi.fn(), vi.fn());
    const code = await transfer.offer();
    expect(code).toMatch(/^[a-f0-9]{32}$/);
    const call = mocks.setDoc.mock.calls[0] as unknown as [
      string,
      { offer: string; answer: null; expiresAt: { toMillis(): number } },
    ];
    expect(call[0]).toBe('users/owner/pairings/' + code);
    expect(call[1].offer).toBe('test SDP');
    expect(call[1].expiresAt.toMillis()).toBeLessThan(Date.now() + 600000);
    await transfer.close();
    expect(mocks.deleteDoc).toHaveBeenCalledOnce();
  });
  it('sends bounded 16 KiB messages and verifies bytes before accepting', async () => {
    vi.stubGlobal('RTCPeerConnection', Peer);
    const complete = vi.fn();
    const transfer = new PhotoTransfer(vi.fn(), complete);
    await transfer.offer();
    const blob = new Blob([new Uint8Array(45000).fill(42)]);
    await transfer.send(blob);
    const sent = channel.messages.slice();
    expect(
      (sent.filter((m) => m instanceof ArrayBuffer) as ArrayBuffer[]).every(
        (m) => m.byteLength <= 16384,
      ),
    ).toBe(true);
    for (const data of sent) channel.onmessage?.({ data });
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    expect(await photoHash(complete.mock.calls[0][0])).toBe(await photoHash(blob));
    expect(channel.readyState).toBe('closed');
  });
  it('rejects corrupt or truncated packages without calling import', async () => {
    vi.stubGlobal('RTCPeerConnection', Peer);
    const complete = vi.fn(),
      status = vi.fn();
    const transfer = new PhotoTransfer(status, complete);
    await transfer.offer();
    channel.onmessage?.({ data: JSON.stringify({ kind: 'start', size: 4, hash: 'a'.repeat(64) }) });
    channel.onmessage?.({ data: new Uint8Array([1, 2]).buffer });
    channel.onmessage?.({ data: JSON.stringify({ kind: 'end' }) });
    await vi.waitFor(() => expect(channel.readyState).toBe('closed'));
    expect(complete).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(expect.stringContaining('Nothing was imported'));
  });
  it('expires pairing while idle and releases the connection', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('RTCPeerConnection', Peer);
    const status = vi.fn();
    const transfer = new PhotoTransfer(status, vi.fn());
    await transfer.offer();
    await vi.advanceTimersByTimeAsync(600000);
    expect(channel.readyState).toBe('closed');
    expect(status).toHaveBeenCalledWith(expect.stringContaining('expired'));
  });
});
