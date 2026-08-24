import { UsbipClosedError, UsbipProtocolError, UsbipTransferError } from './errors.js';
import {
  decodeOpHeader,
  decodeUrbHeader,
  decodeUsbDevice,
  decodeUsbInterface,
  encodeCmdSubmit,
  encodeCmdUnlink,
  encodeOpReqDevlist,
  encodeOpReqImport,
  makeDevid,
} from './protocol/codec.js';
import {
  OP_REP_DEVLIST,
  OP_REP_IMPORT,
  SIZEOF_OP_HEADER,
  SIZEOF_URB_HEADER,
  SIZEOF_USB_DEVICE,
  SIZEOF_USB_INTERFACE,
  USBIP_DIR_IN,
  USBIP_DIR_OUT,
} from './protocol/constants.js';
import { ByteReader } from './protocol/reader.js';
import type { CmdSubmit, UsbipDeviceInfo } from './protocol/types.js';
import type { UsbipTransport } from './transport/types.js';
import { UsbipDevice } from './device.js';

/**
 * A URB awaiting its reply.
 *
 * `expectedLength` is recorded at submit time precisely because RET_SUBMIT's
 * own `direction` field cannot be trusted -- see decodeUrbHeader.
 */
interface Pending {
  isIn: boolean;
  expectedLength: number;
  resolve: (r: { data: Uint8Array; status: number }) => void;
  reject: (e: Error) => void;
  /**
   * Set once the caller has aborted and been rejected. The entry deliberately
   * stays in the map: `isIn` is the only way to know whether a late reply
   * carries a payload that must be drained off the stream.
   */
  abandoned?: boolean;
}

type State = 'idle' | 'op' | 'urb' | 'closed';

export interface UsbipClientOptions {
  /**
   * Milliseconds to wait for an op-phase reply. Guards against a bridge that
   * connected to something that is not a usbipd. Default 10s; 0 disables.
   */
  opTimeoutMs?: number;
}

/**
 * A USB/IP session over one transport.
 *
 * A single connection serves either the op phase (listDevices) or, after a
 * successful import, the URB phase -- never both. This mirrors the reference
 * implementation, where `usbip list` and `usbip attach` each open their own
 * TCP connection. Call `listDevices` on one client and `importDevice` on
 * another if you need both.
 */
export class UsbipClient {
  #transport: UsbipTransport;
  #reader = new ByteReader();
  #state: State = 'idle';
  #seqnum = 0;
  #pending = new Map<number, Pending>();
  /** Unlink command seqnum -> the URB seqnum it is cancelling. */
  #unlinks = new Map<number, number>();
  #device: UsbipDevice | null = null;
  #opTimeoutMs: number;

  constructor(transport: UsbipTransport, options: UsbipClientOptions = {}) {
    this.#transport = transport;
    this.#opTimeoutMs = options.opTimeoutMs ?? 10_000;
    this.#transport.onData((chunk) => this.#reader.push(chunk));
    this.#transport.onClose((cause) => this.#onClose(cause));
  }

  get connected(): boolean {
    return this.#state === 'op' || this.#state === 'urb';
  }

  async connect(): Promise<void> {
    if (this.#state !== 'idle') throw new UsbipProtocolError(`cannot connect in state ${this.#state}`);
    await this.#transport.open();
    this.#state = 'op';
  }

  /** OP_REQ_DEVLIST. Only valid before an import. */
  async listDevices(): Promise<UsbipDeviceInfo[]> {
    this.#requireState('op', 'listDevices');
    await this.#transport.send(encodeOpReqDevlist());

    const header = decodeOpHeader(await this.#readOp(SIZEOF_OP_HEADER));
    this.#expectOk(header, OP_REP_DEVLIST, 'OP_REP_DEVLIST');

    const countBytes = await this.#readOp(4);
    const count = new DataView(
      countBytes.buffer,
      countBytes.byteOffset,
      countBytes.byteLength,
    ).getUint32(0, false);

    const devices: UsbipDeviceInfo[] = [];
    for (let i = 0; i < count; i++) {
      const device = decodeUsbDevice(await this.#readOp(SIZEOF_USB_DEVICE));
      for (let j = 0; j < device.numInterfaces; j++) {
        device.interfaces.push(decodeUsbInterface(await this.#readOp(SIZEOF_USB_INTERFACE)));
      }
      devices.push(device);
    }
    return devices;
  }

  /**
   * OP_REQ_IMPORT. On success the connection switches irreversibly to the URB
   * phase and the returned device owns it.
   */
  async importDevice(busid: string): Promise<UsbipDevice> {
    this.#requireState('op', 'importDevice');
    await this.#transport.send(encodeOpReqImport(busid));

    const header = decodeOpHeader(await this.#readOp(SIZEOF_OP_HEADER));
    this.#expectOk(header, OP_REP_IMPORT, `import of ${busid}`);

    const info = decodeUsbDevice(await this.#readOp(SIZEOF_USB_DEVICE));
    this.#state = 'urb';
    this.#device = new UsbipDevice(this, info, makeDevid(info.busnum, info.devnum));
    void this.#urbLoop();
    return this.#device;
  }

  async close(): Promise<void> {
    if (this.#state === 'closed') return;
    this.#state = 'closed';
    await this.#transport.close();
    this.#onClose();
  }

  // -- internals used by UsbipDevice ----------------------------------------

  /** @internal */
  async submit(
    ep: number,
    isIn: boolean,
    body: Omit<CmdSubmit, 'transferBufferLength'> & { transferBufferLength: number },
    payload: Uint8Array | undefined,
    devid: number,
    signal?: AbortSignal,
  ): Promise<{ data: Uint8Array; status: number }> {
    this.#requireState('urb', 'submit');
    signal?.throwIfAborted();

    const seqnum = this.#nextSeqnum();
    const direction = isIn ? USBIP_DIR_IN : USBIP_DIR_OUT;

    const promise = new Promise<{ data: Uint8Array; status: number }>((resolve, reject) => {
      this.#pending.set(seqnum, {
        isIn,
        expectedLength: body.transferBufferLength,
        resolve,
        reject,
      });
    });

    const onAbort = () => {
      const pending = this.#pending.get(seqnum);
      if (!pending) return;

      // Reject the caller now, but KEEP the entry. Aborting is a race, not a
      // cancellation: the URB may already have completed on the device, in
      // which case the server sends an ordinary RET_SUBMIT carrying real
      // payload bytes -- it has no idea we stopped caring. Forgetting the
      // entry would lose `isIn`, so those bytes would never be read out of
      // the stream and every subsequent header would be parsed from the
      // middle of a payload. The entry is retired when the matching reply
      // actually arrives.
      pending.abandoned = true;
      pending.reject(new DOMException('The transfer was aborted.', 'AbortError'));

      const unlinkSeqnum = this.#nextSeqnum();
      this.#unlinks.set(unlinkSeqnum, seqnum);
      void this.#transport
        .send(encodeCmdUnlink({ command: 0, seqnum: unlinkSeqnum, devid, direction: 0, ep: 0 }, seqnum))
        .catch(() => {});
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      await this.#transport.send(
        encodeCmdSubmit({ command: 0, seqnum, devid, direction, ep }, body, payload),
      );
      return await promise;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  // -- private ---------------------------------------------------------------

  #nextSeqnum(): number {
    // Wrap before 2^32; 0 is avoided since some tooling treats it as "unset".
    this.#seqnum = (this.#seqnum + 1) >>> 0 || 1;
    return this.#seqnum;
  }

  #requireState(want: State, what: string): void {
    if (this.#state !== want) {
      throw new UsbipProtocolError(`${what} requires state '${want}', but client is '${this.#state}'`);
    }
  }

  #expectOk(header: { code: number; status: number }, wantCode: number, what: string): void {
    if (header.code !== wantCode) {
      throw new UsbipProtocolError(
        `${what}: expected code 0x${wantCode.toString(16)}, got 0x${header.code.toString(16)}`,
      );
    }
    if (header.status !== 0) {
      throw new UsbipProtocolError(`${what} failed with status ${header.status}`, header.status);
    }
  }

  /** Read with a timeout, so a wrong host does not hang forever. */
  async #readOp(n: number): Promise<Uint8Array> {
    if (this.#opTimeoutMs <= 0) return this.#reader.read(n);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new UsbipProtocolError(`timed out waiting ${this.#opTimeoutMs}ms for ${n} bytes`)),
        this.#opTimeoutMs,
      );
    });
    try {
      return await Promise.race([this.#reader.read(n), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Dispatch RET_SUBMIT / RET_UNLINK until the connection ends. */
  async #urbLoop(): Promise<void> {
    try {
      while (this.#state === 'urb') {
        const reply = decodeUrbHeader(await this.#reader.read(SIZEOF_URB_HEADER));

        if (reply.kind === 'unlink') {
          // RET_UNLINK echoes the unlink command's own seqnum, not the URB it
          // cancelled, so the victim is looked up rather than deleted
          // directly. Its arrival means the URB really was cancelled and no
          // RET_SUBMIT is coming, so the abandoned entry can be retired.
          const victim = this.#unlinks.get(reply.header.seqnum);
          this.#unlinks.delete(reply.header.seqnum);
          if (victim !== undefined) this.#pending.delete(victim);
          continue;
        }

        const pending = this.#pending.get(reply.header.seqnum);
        const { status, actualLength } = reply.body;

        // Payload presence comes from OUR record of the request, never from
        // the reply's direction field, which usbipd implementations do not
        // set reliably. Abandoned entries are consulted for exactly this
        // reason: the bytes must come off the stream even though nobody
        // wants them any more.
        const hasPayload = (pending?.isIn ?? false) && actualLength > 0;
        const data = hasPayload ? await this.#reader.read(actualLength) : new Uint8Array(0);

        if (!pending) continue; // unknown seqnum; nothing further to do
        this.#pending.delete(reply.header.seqnum);

        // The caller was already rejected when they aborted; this reply only
        // existed to be drained.
        if (pending.abandoned) continue;

        if (status !== 0) {
          pending.reject(new UsbipTransferError(`transfer failed with status ${status}`, status));
        } else {
          pending.resolve({ data, status });
        }
      }
    } catch (cause) {
      this.#onClose(cause instanceof Error ? cause : new Error(String(cause)));
    }
  }

  #onClose(cause?: Error): void {
    if (this.#state !== 'closed') this.#state = 'closed';
    this.#reader.close(cause);
    const error = cause ?? new UsbipClosedError('connection closed');
    for (const pending of this.#pending.values()) {
      if (!pending.abandoned) pending.reject(error);
    }
    this.#pending.clear();
    this.#unlinks.clear();
  }
}
