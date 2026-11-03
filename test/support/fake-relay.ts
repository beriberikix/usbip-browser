/**
 * An in-process stand-in for relaynet, for tests.
 *
 * It replaces only the relay itself: it answers DHCP the way relaynet does
 * (one address per MAC, held across reconnects) and switches Ethernet frames
 * between the session under test and a "bridge" -- a second lwIP stack at
 * 10.0.2.15 whose port 3240 is served by MockTransport, the emulated usbipd.
 * relaynet's real client helper drives it through its `WebSocket` option, and
 * the transport's real stack talks to the bridge's real stack, so the frames,
 * the DHCP exchange and the TCP connection are all genuine.
 */
import { createStack } from 'tcpip';
import { internetChecksum } from '../../src/transport/dhcp.js';
import { MockTransport } from '../../src/mock/index.js';

export const BRIDGE_ADDRESS = '10.0.2.15';
const GATEWAY = [10, 0, 2, 2];
const GATEWAY_MAC = [0x52, 0x54, 0x00, 0x12, 0x34, 0x56];

const macKey = (mac: Uint8Array): string => Array.from(mac, (b) => b.toString(16)).join(':');

interface DhcpRequest {
  mac: Uint8Array;
  xid: number;
  type: number;
}

function parseDhcpRequest(f: Uint8Array): DhcpRequest | null {
  if (f.length < 282 || f[12] !== 0x08 || f[13] !== 0x00 || f[23] !== 17) return null;
  const v = new DataView(f.buffer, f.byteOffset, f.byteLength);
  const udp = 14 + (f[14]! & 0x0f) * 4;
  if (v.getUint16(udp + 2) !== 67) return null;
  const bootp = udp + 8;
  let type = 0;
  for (let i = bootp + 240; i < f.length && f[i] !== 255; ) {
    if (f[i] === 0) {
      i++;
      continue;
    }
    if (f[i] === 53) type = f[i + 2]!;
    i += 2 + f[i + 1]!;
  }
  return { mac: f.slice(6, 12), xid: v.getUint32(bootp + 4), type };
}

function dhcpReply(request: DhcpRequest, type: number, address: number[]): Uint8Array {
  const opts = [53, 1, type, 54, 4, ...GATEWAY, 1, 4, 255, 255, 255, 0, 3, 4, ...GATEWAY, 51, 4, 0, 0, 0x0e, 0x10, 255];
  const bootp = new Uint8Array(240 + opts.length);
  const b = new DataView(bootp.buffer);
  bootp.set([2, 1, 6]);
  b.setUint32(4, request.xid);
  bootp.set(address, 16);
  bootp.set(request.mac, 28);
  b.setUint32(236, 0x63825363);
  bootp.set(opts, 240);
  const frame = new Uint8Array(42 + bootp.length);
  const f = new DataView(frame.buffer);
  frame.fill(0xff, 0, 6);
  frame.set(GATEWAY_MAC, 6);
  f.setUint16(12, 0x0800);
  frame[14] = 0x45;
  f.setUint16(16, 28 + bootp.length);
  frame[22] = 64;
  frame[23] = 17;
  frame.set(GATEWAY, 26);
  frame.fill(0xff, 30, 34);
  f.setUint16(24, internetChecksum(frame.subarray(14, 34)));
  f.setUint16(34, 67);
  f.setUint16(36, 68);
  f.setUint16(38, 8 + bootp.length);
  frame.set(bootp, 42);
  return frame;
}

export class FakeRelay {
  /** Addresses by MAC, kept across sessions as relaynet holds them. */
  leases = new Map<string, number[]>();
  nextHost = 16;
  /** Subprotocol lists each WebSocket was opened with. */
  handshakes: string[][] = [];
  sessions = 0;
  /** Refuse every upgrade, as a relay does for a bad token. */
  refuse = false;

  #current: FakeSocket | null = null;
  #toBridge!: WritableStreamDefaultWriter<Uint8Array>;

  private constructor() {}

  static async create(): Promise<FakeRelay> {
    const relay = new FakeRelay();
    const stack = await createStack();
    const tap = await stack.interfaces.createTap({ ip: `${BRIDGE_ADDRESS}/24` } as never);
    relay.#toBridge = tap.writable.getWriter();
    tap.readable
      .pipeTo(new WritableStream({ write: (frame) => relay.#current?.deliver(frame) }))
      .catch(() => {});
    const listener = await stack.listenTcp({ port: 3240 });
    void (async () => {
      for await (const connection of listener as AsyncIterable<{
        readable: ReadableStream<Uint8Array>;
        writable: WritableStream<Uint8Array>;
      }>) {
        const usbipd = new MockTransport();
        const writer = connection.writable.getWriter();
        usbipd.onData((chunk) => void writer.write(chunk).catch(() => {}));
        void usbipd.open();
        void (async () => {
          const reader = connection.readable.getReader();
          for (;;) {
            const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
            if (done || !value) break;
            await usbipd.send(value).catch(() => {});
          }
        })();
      }
    })();
    return relay;
  }

  /** A WebSocket constructor for relaynet's helper. */
  get WebSocket(): unknown {
    const relay = this;
    return class extends FakeSocket {
      constructor(url: string, protocols: string[]) {
        super(relay, url, protocols);
      }
    };
  }

  /** Drop the session without a close frame (sleep, network change). */
  drop(): void {
    this.#current?.serverClose(1006, '');
  }

  /** End the session for good, as relaynet does for a revoked token. */
  end(reason = 'token revoked'): void {
    this.#current?.serverClose(1008, reason);
  }

  /** Forget held addresses, so the next DHCP gets a new one. */
  forgetLeases(): void {
    this.leases.clear();
  }

  attach(socket: FakeSocket): void {
    this.handshakes.push(socket.protocols);
    this.sessions++;
    this.#current = socket;
  }

  detach(socket: FakeSocket): void {
    if (this.#current === socket) this.#current = null;
  }

  fromClient(socket: FakeSocket, frame: Uint8Array): void {
    const dhcp = parseDhcpRequest(frame);
    if (dhcp) {
      const key = macKey(dhcp.mac);
      let address = this.leases.get(key);
      if (!address) {
        address = [10, 0, 2, this.nextHost++];
        this.leases.set(key, address);
      }
      if (dhcp.type === 1) socket.deliver(dhcpReply(dhcp, 2, address));
      else if (dhcp.type === 3) socket.deliver(dhcpReply(dhcp, 5, address));
      return;
    }
    // relaynet routes between sessions by lease: IPv4 from an address it did
    // not hand to this session's MAC goes nowhere. (ARP passes.)
    if (frame[12] === 0x08 && frame[13] === 0x00) {
      const leased = this.leases.get(macKey(frame.subarray(6, 12)));
      const source = Array.from(frame.subarray(26, 30));
      if (!leased || leased.join('.') !== source.join('.')) {
        this.unroutable++;
        return;
      }
    }
    void this.#toBridge.write(frame).catch(() => {});
  }

  /** IPv4 frames dropped because their source held no lease. */
  unroutable = 0;
}

class FakeSocket {
  static readonly OPEN = 1;
  readyState = 0;
  binaryType = 'blob';
  protocol = '';
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(
    readonly relay: FakeRelay,
    readonly url: string,
    readonly protocols: string[],
  ) {
    queueMicrotask(() => {
      if (relay.refuse) {
        this.readyState = 3;
        this.onclose?.({ code: 1006, reason: '' });
        return;
      }
      relay.attach(this);
      this.readyState = 1;
      this.protocol = 'relay.v1';
      this.onopen?.();
    });
  }

  send(data: Uint8Array | string): void {
    if (typeof data === 'string') return; // ping:
    this.relay.fromClient(this, new Uint8Array(data));
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.relay.detach(this);
    this.onclose?.({ code, reason });
  }

  serverClose(code: number, reason: string): void {
    this.close(code, reason);
  }

  deliver(frame: Uint8Array): void {
    if (this.readyState !== 1) return;
    const copy = frame.slice();
    this.onmessage?.({ data: copy.buffer });
  }
}
