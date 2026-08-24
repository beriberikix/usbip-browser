/**
 * An in-process USB/IP server emulating a CDC-ACM serial device.
 *
 * This exists so the hosted demo works with zero setup, but it is not a stub:
 * it encodes and decodes the same wire format as a real usbipd, through the
 * same codec module. A bug in the parser fails here too, which is the point.
 */
import {
  decodeCmdSubmit,
  decodeOpHeader,
  encodeRetSubmit,
  encodeRetUnlink,
  encodeUsbDevice,
  encodeUsbInterface,
  makeDevid,
} from '../protocol/codec.js';
import {
  OP_REP_DEVLIST,
  OP_REP_IMPORT,
  OP_REQ_DEVLIST,
  OP_REQ_IMPORT,
  SIZEOF_OP_HEADER,
  SIZEOF_URB_HEADER,
  USBIP_BUSID_SIZE,
  USBIP_CMD_SUBMIT,
  USBIP_CMD_UNLINK,
  USBIP_DIR_IN,
  USBIP_VERSION,
} from '../protocol/constants.js';
import { ByteReader } from '../protocol/reader.js';
import type { UsbipDeviceInfo, UsbipHeaderBasic } from '../protocol/types.js';
import type { UsbipTransport } from '../transport/types.js';

const BE = false;

/** The device this mock pretends to be: a USB serial adapter. */
export const MOCK_DEVICE: UsbipDeviceInfo = {
  path: '/sys/devices/pci0000:00/0000:00:14.0/usb1/1-1',
  busid: '1-1',
  busnum: 1,
  devnum: 2,
  speed: 'full',
  vendorId: 0x2e8a,
  productId: 0x000a,
  bcdDevice: 0x0100,
  deviceClass: 0x02, // Communications
  deviceSubClass: 0x00,
  deviceProtocol: 0x00,
  configurationValue: 1,
  numConfigurations: 1,
  numInterfaces: 2,
  interfaces: [
    { interfaceClass: 0x02, interfaceSubClass: 0x02, interfaceProtocol: 0x01 }, // CDC control
    { interfaceClass: 0x0a, interfaceSubClass: 0x00, interfaceProtocol: 0x00 }, // CDC data
  ],
};

const BULK_IN_EP = 2;
const BULK_OUT_EP = 1;

function encodeOpHeader(code: number, status = 0): Uint8Array {
  const out = new Uint8Array(SIZEOF_OP_HEADER);
  const view = new DataView(out.buffer);
  view.setUint16(0, USBIP_VERSION, BE);
  view.setUint16(2, code, BE);
  view.setUint32(4, status, BE);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * A tiny line-oriented shell, so the demo terminal does something.
 * Returns the bytes the device would emit in response to one input byte.
 */
class MockShell {
  #line = '';

  readonly banner =
    'usbip-browser mock device\r\n' +
    "CDC-ACM emulation. Type 'help' for commands.\r\n\r\n$ ";

  /** Feed one byte of host input; get back what the device echoes. */
  feed(byte: number): string {
    // Carriage return or newline ends the line.
    if (byte === 0x0d || byte === 0x0a) {
      const line = this.#line;
      this.#line = '';
      return '\r\n' + this.#run(line.trim()) + '$ ';
    }
    // Backspace / delete.
    if (byte === 0x08 || byte === 0x7f) {
      if (this.#line.length === 0) return '';
      this.#line = this.#line.slice(0, -1);
      return '\b \b';
    }
    // Ctrl-C.
    if (byte === 0x03) {
      this.#line = '';
      return '^C\r\n$ ';
    }
    if (byte < 0x20) return ''; // ignore other control bytes
    const char = String.fromCharCode(byte);
    this.#line += char;
    return char; // local echo
  }

  #run(line: string): string {
    if (line === '') return '';
    const [command, ...args] = line.split(/\s+/);
    switch (command) {
      case 'help':
        return [
          'Available commands:',
          '  help     show this message',
          '  echo     print the arguments',
          '  uname    show system information',
          '  id       show the emulated USB identity',
          '  clear    clear the screen',
          '',
        ].join('\r\n');
      case 'echo':
        return args.join(' ') + '\r\n';
      case 'uname':
        return 'usbip-browser mock 0.1.0 (CDC-ACM)\r\n';
      case 'id': {
        const vid = MOCK_DEVICE.vendorId.toString(16).padStart(4, '0');
        const pid = MOCK_DEVICE.productId.toString(16).padStart(4, '0');
        return `busid ${MOCK_DEVICE.busid}  ${vid}:${pid}  speed ${MOCK_DEVICE.speed}\r\n`;
      }
      case 'clear':
        return '\x1b[2J\x1b[H';
      default:
        return `${command}: command not found\r\n`;
    }
  }
}

export interface MockTransportOptions {
  /** Device to advertise. Defaults to MOCK_DEVICE. */
  device?: UsbipDeviceInfo;
  /** Artificial round-trip latency in ms, to make the demo feel real. Default 0. */
  latencyMs?: number;
}

/**
 * A transport whose far end is an emulated usbipd.
 *
 * Drop it into UsbipClient exactly like WispTransport; no network involved.
 */
export class MockTransport implements UsbipTransport {
  #device: UsbipDeviceInfo;
  #latency: number;
  #dataHandler: ((chunk: Uint8Array) => void) | null = null;
  #closeHandler: ((cause?: Error) => void) | null = null;
  #reader = new ByteReader();
  #closed = false;
  #shell = new MockShell();

  /** Bytes the emulated device wants to send to the host. */
  #tx: number[] = [];
  /** Bulk IN requests parked until the device has something to say. */
  #pendingIn: Array<{ header: UsbipHeaderBasic; length: number }> = [];

  constructor(options: MockTransportOptions = {}) {
    this.#device = options.device ?? MOCK_DEVICE;
    this.#latency = options.latencyMs ?? 0;
  }

  onData(handler: (chunk: Uint8Array) => void): void {
    this.#dataHandler = handler;
  }

  onClose(handler: (cause?: Error) => void): void {
    this.#closeHandler = handler;
  }

  async open(): Promise<void> {
    void this.#serve();
  }

  async send(chunk: Uint8Array): Promise<void> {
    if (this.#closed) throw new Error('MockTransport is closed');
    this.#reader.push(chunk.slice());
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#reader.close();
    this.#closeHandler?.();
  }

  // -- server side -----------------------------------------------------------

  async #emit(bytes: Uint8Array): Promise<void> {
    if (this.#latency > 0) await new Promise((r) => setTimeout(r, this.#latency));
    if (this.#closed) return;
    this.#dataHandler?.(bytes);
  }

  /** Op phase, then (after a successful import) the URB phase. */
  async #serve(): Promise<void> {
    try {
      const header = decodeOpHeader(await this.#reader.read(SIZEOF_OP_HEADER));

      if (header.code === OP_REQ_DEVLIST) {
        const count = new Uint8Array(4);
        new DataView(count.buffer).setUint32(0, 1, BE);
        await this.#emit(
          concat([
            encodeOpHeader(OP_REP_DEVLIST),
            count,
            encodeUsbDevice(this.#device),
            ...this.#device.interfaces.map(encodeUsbInterface),
          ]),
        );
        return; // usbipd closes the connection after a device list
      }

      if (header.code !== OP_REQ_IMPORT) {
        await this.#emit(encodeOpHeader(OP_REP_IMPORT, 1));
        return;
      }

      const busidBytes = await this.#reader.read(USBIP_BUSID_SIZE);
      const end = busidBytes.indexOf(0);
      const busid = new TextDecoder().decode(
        end === -1 ? busidBytes : busidBytes.subarray(0, end),
      );

      if (busid !== this.#device.busid) {
        await this.#emit(encodeOpHeader(OP_REP_IMPORT, 1)); // ENODEV
        return;
      }

      await this.#emit(concat([encodeOpHeader(OP_REP_IMPORT), encodeUsbDevice(this.#device)]));
      // Greet the terminal the way a real device would after DTR is asserted.
      this.#queue(this.#shell.banner);
      await this.#urbLoop();
    } catch {
      // Reader closed: the client went away. Nothing to report.
    }
  }

  async #urbLoop(): Promise<void> {
    const devid = makeDevid(this.#device.busnum, this.#device.devnum);

    for (;;) {
      const raw = await this.#reader.read(SIZEOF_URB_HEADER);
      const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      const command = view.getUint32(0, BE);

      if (command === USBIP_CMD_UNLINK) {
        const seqnum = view.getUint32(4, BE);
        const victim = view.getUint32(20, BE);
        this.#pendingIn = this.#pendingIn.filter((p) => p.header.seqnum !== victim);
        await this.#emit(
          encodeRetUnlink({ command: 0, seqnum, devid, direction: 0, ep: 0 }, 0),
        );
        continue;
      }

      if (command !== USBIP_CMD_SUBMIT) continue;

      const { header, body } = decodeCmdSubmit(raw);
      const isIn = header.direction === USBIP_DIR_IN;
      const payload = isIn
        ? new Uint8Array(0)
        : await this.#reader.read(Math.max(0, body.transferBufferLength));

      if (header.ep === 0) {
        await this.#handleControl(header, body.setup, body.transferBufferLength, isIn);
        continue;
      }

      if (isIn && header.ep === BULK_IN_EP) {
        this.#pendingIn.push({ header, length: body.transferBufferLength });
        void this.#drain();
        continue;
      }

      if (!isIn && header.ep === BULK_OUT_EP) {
        for (const byte of payload) this.#queue(this.#shell.feed(byte));
        await this.#emit(
          encodeRetSubmit(header, { status: 0, actualLength: payload.length }),
        );
        void this.#drain();
        continue;
      }

      // Unknown endpoint: report EPIPE, the same as a stalled device would.
      await this.#emit(encodeRetSubmit(header, { status: -32, actualLength: 0 }));
    }
  }

  async #handleControl(
    header: UsbipHeaderBasic,
    setup: Uint8Array,
    length: number,
    isIn: boolean,
  ): Promise<void> {
    // Every configuration request this mock cares about (SET_CONFIGURATION,
    // SET_LINE_CODING, SET_CONTROL_LINE_STATE) is an OUT with no reply body.
    if (!isIn) {
      await this.#emit(encodeRetSubmit(header, { status: 0, actualLength: 0 }));
      return;
    }
    // IN control transfers: return zeros of the requested length. Descriptor
    // fidelity is not needed here -- the client learns the device shape from
    // OP_REP_DEVLIST, not from descriptor reads.
    await this.#emit(
      encodeRetSubmit(header, { status: 0, actualLength: length }, new Uint8Array(length)),
    );
    void setup;
  }

  #queue(text: string): void {
    if (!text) return;
    for (const byte of new TextEncoder().encode(text)) this.#tx.push(byte);
  }

  /** Fulfil parked bulk IN requests as data becomes available. */
  async #drain(): Promise<void> {
    while (this.#pendingIn.length > 0 && this.#tx.length > 0 && !this.#closed) {
      const request = this.#pendingIn.shift()!;
      const take = Math.min(request.length, this.#tx.length);
      const chunk = new Uint8Array(this.#tx.splice(0, take));
      await this.#emit(
        encodeRetSubmit(request.header, { status: 0, actualLength: chunk.length }, chunk),
      );
    }
  }
}
