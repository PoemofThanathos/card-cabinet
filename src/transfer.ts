import {
  doc,
  setDoc,
  getDocFromServer,
  onSnapshot,
  deleteDoc,
  runTransaction,
  Timestamp,
} from 'firebase/firestore';
import { auth, firestore } from './firebase';
import { PACKAGE_LIMIT, assertExportAvailable } from './backup';
import { photoHash, db, type CabinetDB } from './db';

const CHUNK = 16 * 1024;
export class PhotoTransfer {
  private pc: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private unsubscribe?: () => void;
  private room?: ReturnType<typeof doc>;
  private timer: ReturnType<typeof setTimeout>;
  private chunks: ArrayBuffer[] = [];
  private received = 0;
  private expected?: { size: number; hash: string };
  private closed = false;
  private inbound = Promise.resolve();
  constructor(
    private status: (message: string) => void,
    private complete: (blob: Blob) => void,
  ) {
    if (!auth?.currentUser || !firestore)
      throw new Error('Sign in on both devices with the same account first.');
    // No paid TURN dependency. Host candidates only; connection is not guaranteed.
    this.pc = new RTCPeerConnection({ iceServers: [] });
    this.pc.ondatachannel = (e) => this.attach(e.channel);
    this.pc.onconnectionstatechange = () => {
      status('Connection: ' + this.pc.connectionState);
      if (['failed', 'disconnected'].includes(this.pc.connectionState)) void this.close();
    };
    this.timer = setTimeout(
      () => {
        status('Pairing expired. Use a backup file or create a new pairing.');
        void this.close();
      },
      10 * 60 * 1000,
    );
  }
  private attach(channel: RTCDataChannel) {
    this.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = 64 * 1024;
    channel.onopen = () =>
      this.status('Connected. The sending device can now send its prepared package.');
    channel.onmessage = (e) => {
      this.inbound = this.inbound
        .then(() => {
          if (!this.closed) return this.receive(e.data);
        })
        .catch(() => {
          this.status('Transfer failed integrity or size checks. Nothing was imported.');
          void this.close();
        });
    };
    channel.onerror = () => {
      this.status('Direct transfer failed. Use a backup file.');
      void this.close();
    };
  }
  private async gathered() {
    if (this.pc.iceGatheringState === 'complete') return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pc.removeEventListener('icegatheringstatechange', check);
        reject(new Error('Network discovery timed out. Use a backup file.'));
      }, 15000);
      const check = () => {
        if (this.pc.iceGatheringState === 'complete') {
          clearTimeout(timeout);
          this.pc.removeEventListener('icegatheringstatechange', check);
          resolve();
        }
      };
      this.pc.addEventListener('icegatheringstatechange', check);
    });
  }
  async offer() {
    const code = [...crypto.getRandomValues(new Uint8Array(16))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    this.room = doc(firestore!, 'users', auth!.currentUser!.uid, 'pairings', code);
    this.attach(this.pc.createDataChannel('card-cabinet', { ordered: true }));
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await this.gathered();
    await setDoc(this.room, {
      offer: this.pc.localDescription!.sdp,
      answer: null,
      expiresAt: Timestamp.fromMillis(Date.now() + 9 * 60 * 1000),
    });
    let answered = false;
    this.unsubscribe = onSnapshot(
      this.room,
      (snapshot) => {
        const answer = snapshot.data()?.answer;
        if (typeof answer === 'string' && !answered) {
          answered = true;
          void this.pc.setRemoteDescription({ type: 'answer', sdp: answer }).catch(() => {
            this.status('Pairing failed. Use a backup file.');
            void this.close();
          });
        }
      },
      () => {
        this.status('Signaling is unavailable. Use a backup file.');
        void this.close();
      },
    );
    return code;
  }
  async join(code: string) {
    if (!/^[a-f0-9]{32}$/.test(code.trim()))
      throw new Error('Paste the full 32-character pairing code.');
    this.room = doc(firestore!, 'users', auth!.currentUser!.uid, 'pairings', code.trim());
    const snapshot = await getDocFromServer(this.room);
    const data = snapshot.data();
    if (!data || data.expiresAt.toMillis() < Date.now() || data.answer)
      throw new Error('Pairing expired or was already used.');
    await this.pc.setRemoteDescription({ type: 'offer', sdp: data.offer });
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await this.gathered();
    await runTransaction(firestore!, async (tx) => {
      const current = (await tx.get(this.room!)).data();
      if (!current || current.answer || current.expiresAt.toMillis() < Date.now())
        throw new Error('Pairing is no longer available.');
      tx.update(this.room!, { answer: this.pc.localDescription!.sdp });
    });
  }
  async send(blob: Blob, cardIds: string[], database: CabinetDB = db) {
    const channel = this.channel;
    if (!channel || channel.readyState !== 'open')
      throw new Error('Wait for both devices to connect.');
    if (blob.size > PACKAGE_LIMIT + 1024 * 1024)
      throw new Error('Transfer is limited to a 200 MB package. Export a smaller selection.');
    const check = async () => {
      try {
        await assertExportAvailable(cardIds, database);
      } catch (error) {
        await this.close();
        throw error;
      }
    };
    const hash = await photoHash(blob);
    await check();
    channel.send(JSON.stringify({ kind: 'start', size: blob.size, hash }));
    for (let offset = 0; offset < blob.size; offset += CHUNK) {
      if (offset > 0 && offset % (256 * 1024) === 0) await check();
      if (channel.bufferedAmount > 256 * 1024)
        await new Promise<void>((resolve, reject) => {
          const done = () => {
            clearTimeout(timer);
            channel.removeEventListener('bufferedamountlow', done);
            resolve();
          };
          const timer = setTimeout(() => {
            channel.removeEventListener('bufferedamountlow', done);
            reject(new Error('Transfer stalled. Keep both apps open, or use a backup file.'));
          }, 15000);
          channel.addEventListener('bufferedamountlow', done);
        });
      if (channel.readyState !== 'open')
        throw new Error('Connection closed. No partial package will be imported.');
      channel.send(await blob.slice(offset, offset + CHUNK).arrayBuffer());
      this.status(
        'Sending ' + Math.round((Math.min(offset + CHUNK, blob.size) / blob.size) * 100) + '%',
      );
    }
    await check();
    channel.send(JSON.stringify({ kind: 'end' }));
    this.status('Sent. Waiting for the receiving device to verify the package.');
  }
  private async receive(data: unknown) {
    if (typeof data === 'string') {
      if (data.length > 300) throw new Error();
      const msg = JSON.parse(data);
      if (msg.kind === 'start') {
        if (
          this.expected ||
          !Number.isSafeInteger(msg.size) ||
          msg.size <= 0 ||
          msg.size > PACKAGE_LIMIT + 1024 * 1024 ||
          !/^\w{64}$/.test(msg.hash)
        )
          throw new Error();
        this.expected = { size: msg.size, hash: msg.hash };
        this.chunks = [];
        this.received = 0;
      } else if (msg.kind === 'end') {
        if (!this.expected || this.received !== this.expected.size) throw new Error();
        const blob = new Blob(this.chunks, { type: 'application/zip' });
        if ((await photoHash(blob)) !== this.expected.hash) throw new Error();
        this.channel?.send(JSON.stringify({ kind: 'received' }));
        this.complete(blob);
        this.status('Verified. Review the incoming package before importing.');
        await this.close();
      } else if (msg.kind === 'received') {
        this.status('The other device verified the package.');
        await this.close();
      } else throw new Error();
    } else {
      if (
        !(data instanceof ArrayBuffer) ||
        !this.expected ||
        data.byteLength > CHUNK ||
        this.received + data.byteLength > this.expected.size
      )
        throw new Error();
      this.chunks.push(data);
      this.received += data.byteLength;
      this.status('Receiving ' + Math.round((this.received / this.expected.size) * 100) + '%');
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.unsubscribe?.();
    this.channel?.close();
    this.pc.close();
    this.chunks = [];
    if (this.room)
      try {
        await deleteDoc(this.room);
      } catch {
        /* Expired rooms hold SDP only. Rules deny access after expiry. */
      }
  }
}
