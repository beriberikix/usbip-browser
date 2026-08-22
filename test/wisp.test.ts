import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  WISP_CLOSE,
  WISP_CONNECT,
  WISP_CONTINUE,
  WISP_DATA,
  WISP_EXT,
  WISP_INFO,
  WispTransport,
} from '../src/transport/wisp.js';

// -- a WebSocket stand-in the tests drive by hand ----------------------------

type Listener = (event: any) => void;

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static last: FakeWebSocket | null = null;

  readyState = FakeWebSocket.CONNECTING;
  binaryType = 'blob';
  sent: Uint8Array[] = [];
  closed = false;

  #listeners = new Map<string, Listener[]>();

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    FakeWebSocket.last = this;
  }

  addEventListener(type: string, listener: Listener, _options?: unknown): void {
    const list = this.#listeners.get(type) ?? [];
    list.push(listener);
    this.#listeners.set(type, list);
  }

  send(data: Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
  }

  // -- test controls --

  fireOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.#emit('open', {});
  }

  /** Deliver a packet from the "server". */
  receive(type: number, streamId: number, payload: Uint8Array = new Uint8Array(0)): void {
    const frame = new Uint8Array(5 + payload.length);
    const view = new DataView(frame.buffer);
    view.setUint8(0, type);
    view.setUint32(1, streamId, true);
    frame.set(payload, 5);
    this.#emit('message', { data: frame.buffer });
  }

  fireClose(code = 1006, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.#emit('close', { code, reason });
  }

  #emit(type: string, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }

  /** The most recent packet sent, decoded. */
  lastPacket(): { type: number; streamId: number; payload: Uint8Array } {
    const raw = this.sent.at(-1);
    if (!raw) throw new Error('nothing sent');
    return decode(raw);
  }

  packets(): Array<{ type: number; streamId: number; payload: Uint8Array }> {
    return this.sent.map(decode);
  }
}

function decode(raw: Uint8Array) {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  return {
    type: view.getUint8(0),
    streamId: view.getUint32(1, true),
    payload: raw.subarray(5),
  };
}

/** u32 little-endian payload, as CONTINUE carries. */
const u32le = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};

/** Build an INFO payload: major, minor, then extension entries. */
function infoPayload(
  major: number,
  minor: number,
  extensions: Array<{ id: number; payload?: Uint8Array }> = [],
): Uint8Array {
  const parts = extensions.map(({ id, payload = new Uint8Array(0) }) => {
    const entry = new Uint8Array(5 + payload.length);
    const view = new DataView(entry.buffer);
    view.setUint8(0, id);
    view.setUint32(1, payload.length, true);
    entry.set(payload, 5);
    return entry;
  });
  const total = 2 + parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  out[0] = major;
  out[1] = minor;
  let o = 2;
  for (const part of parts) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}

const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  (globalThis as any).WebSocket = FakeWebSocket;
  FakeWebSocket.last = null;
});

afterEach(() => {
  (globalThis as any).WebSocket = originalWebSocket;
});

/** Open a transport and return it plus its socket, after the WS is up. */
async function begin(target = 'localhost:3240', options = {}) {
  const transport = new WispTransport('wss://relay.example/', target, options);
  const opening = transport.open();
  await Promise.resolve();
  const socket = FakeWebSocket.last!;
  socket.fireOpen();
  await Promise.resolve();
  return { transport, socket, opening };
}

describe('target parsing', () => {
  it('rejects a target without a port', () => {
    expect(() => new WispTransport('wss://x/', 'localhost')).toThrow(/host:port/);
  });

  it('rejects an out-of-range port', () => {
    expect(() => new WispTransport('wss://x/', 'localhost:70000')).toThrow(/invalid port/);
  });

  it('accepts a bracketed IPv6 literal', () => {
    expect(() => new WispTransport('wss://x/', '[::1]:3240')).not.toThrow();
  });
});

describe('v2 handshake', () => {
  it('replies with INFO then connects once accepted', async () => {
    const { transport, socket, opening } = await begin();

    socket.receive(WISP_INFO, 0, infoPayload(2, 0));
    await Promise.resolve();

    const info = socket.packets().find((p) => p.type === WISP_INFO);
    expect(info).toBeDefined();
    expect(info!.payload[0]).toBe(2); // we advertise v2

    socket.receive(WISP_CONTINUE, 0, u32le(64));
    await opening;

    expect(transport.version).toBe(2);
    const connect = socket.packets().find((p) => p.type === WISP_CONNECT)!;
    expect(connect.payload[0]).toBe(0x01); // TCP
    expect(new DataView(connect.payload.buffer, connect.payload.byteOffset).getUint16(1, true)).toBe(3240);
    expect(new TextDecoder().decode(connect.payload.subarray(3))).toBe('localhost');
  });

  it('advertises no subprotocol by default', async () => {
    // wisp-server-python 0.9.0 fails the WebSocket handshake if any
    // subprotocol is requested, so the interoperable default is none.
    const { socket } = await begin();
    expect(socket.protocols).toEqual([]);
  });

  it('advertises a subprotocol when one is configured', async () => {
    const { socket } = await begin('localhost:3240', { subprotocols: ['wisp-v2'] });
    expect(socket.protocols).toEqual(['wisp-v2']);
  });

  it('waits for stream confirmation when extension 0x05 is offered', async () => {
    const { transport, socket, opening } = await begin();

    socket.receive(WISP_INFO, 0, infoPayload(2, 0, [{ id: WISP_EXT.STREAM_OPEN_CONFIRMATION }]));
    await Promise.resolve();
    socket.receive(WISP_CONTINUE, 0, u32le(8));
    await Promise.resolve();

    // CONNECT is out, but open() must not resolve until the stream confirms.
    expect(socket.packets().some((p) => p.type === WISP_CONNECT)).toBe(true);
    let settled = false;
    void opening.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    socket.receive(WISP_CONTINUE, 1, u32le(8));
    await opening;
    expect(transport.negotiatedExtensions.has(WISP_EXT.STREAM_OPEN_CONFIRMATION)).toBe(true);
  });

  it('surfaces the MOTD', async () => {
    const seen: string[] = [];
    const { socket, opening } = await begin('localhost:3240', { onMotd: (m: string) => seen.push(m) });

    socket.receive(
      WISP_INFO,
      0,
      infoPayload(2, 0, [{ id: WISP_EXT.MOTD, payload: new TextEncoder().encode('hello there') }]),
    );
    await Promise.resolve();
    socket.receive(WISP_CONTINUE, 0, u32le(4));
    await opening;

    expect(seen).toEqual(['hello there']);
  });
});

describe('v1 fallback', () => {
  it('treats a CONTINUE before any INFO as a v1 server', async () => {
    const { transport, socket, opening } = await begin();

    socket.receive(WISP_CONTINUE, 0, u32le(16));
    await opening;

    expect(transport.version).toBe(1);
    // No INFO should have been sent to a v1 server.
    expect(socket.packets().some((p) => p.type === WISP_INFO)).toBe(false);
    expect(socket.packets().some((p) => p.type === WISP_CONNECT)).toBe(true);
  });
});

describe('password authentication', () => {
  it('sends username and password in the required layout', async () => {
    const { socket, opening } = await begin('localhost:3240', {
      auth: { username: 'ada', password: 'lovelace' },
    });

    socket.receive(
      WISP_INFO,
      0,
      infoPayload(2, 0, [{ id: WISP_EXT.PASSWORD_AUTH, payload: new Uint8Array([1]) }]),
    );
    await Promise.resolve();

    const info = socket.packets().find((p) => p.type === WISP_INFO)!;
    const ext = info.payload.subarray(2);
    expect(ext[0]).toBe(WISP_EXT.PASSWORD_AUTH);
    const length = new DataView(ext.buffer, ext.byteOffset).getUint32(1, true);
    const body = ext.subarray(5, 5 + length);
    expect(body[0]).toBe(3); // username length
    expect(new TextDecoder().decode(body.subarray(1, 4))).toBe('ada');
    expect(new TextDecoder().decode(body.subarray(4))).toBe('lovelace');

    socket.receive(WISP_CONTINUE, 0, u32le(4));
    await opening;
  });

  it('fails clearly when the server requires auth and none was given', async () => {
    const { socket, opening } = await begin();
    socket.receive(
      WISP_INFO,
      0,
      infoPayload(2, 0, [{ id: WISP_EXT.PASSWORD_AUTH, payload: new Uint8Array([1]) }]),
    );
    await expect(opening).rejects.toThrow(/requires password authentication/);
  });

  it('refuses key-only auth rather than pretending to support it', async () => {
    const { socket, opening } = await begin();
    socket.receive(
      WISP_INFO,
      0,
      infoPayload(2, 0, [{ id: WISP_EXT.KEY_AUTH, payload: new Uint8Array([1]) }]),
    );
    await expect(opening).rejects.toThrow(/key authentication/);
  });
});

describe('CLOSE handling', () => {
  it('reports a refused connection through onClose', async () => {
    const transport = new WispTransport('wss://relay.example/', 'localhost:3240');
    const seen: Array<Error | undefined> = [];
    transport.onClose((cause) => seen.push(cause));
    const opening = transport.open();
    await Promise.resolve();
    const socket = FakeWebSocket.last!;
    socket.fireOpen();
    await Promise.resolve();
    socket.receive(WISP_CONTINUE, 0, u32le(4));
    await opening;

    socket.receive(WISP_CLOSE, 1, new Uint8Array([0x43]));
    await Promise.resolve();

    expect(seen[0]?.message).toMatch(/connection refused/);
  });

  it('rejects the handshake when CLOSE arrives during it', async () => {
    const { socket, opening } = await begin();
    socket.receive(WISP_CLOSE, 0, new Uint8Array([0xc2]));
    await expect(opening).rejects.toThrow(/credentials required/);
  });

  it('treats a voluntary closure as a clean end, not an error', async () => {
    // usbipd hangs up after answering OP_REQ_DEVLIST. Surfacing that as an
    // error turns routine protocol behaviour into a spurious failure.
    const transport = new WispTransport('wss://relay.example/', 'localhost:3240');
    const causes: Array<Error | undefined> = [];
    transport.onClose((cause) => causes.push(cause));
    const opening = transport.open();
    await Promise.resolve();
    const socket = FakeWebSocket.last!;
    socket.fireOpen();
    await Promise.resolve();
    socket.receive(WISP_CONTINUE, 0, u32le(4));
    await opening;

    socket.receive(WISP_CLOSE, 1, new Uint8Array([0x02]));
    await Promise.resolve();

    expect(causes).toEqual([undefined]);
  });

  it('still fails a voluntary closure that arrives mid-handshake', async () => {
    // Closing before the stream is usable is a real failure, whatever reason
    // the server states.
    const { socket, opening } = await begin();
    socket.receive(WISP_CLOSE, 0, new Uint8Array([0x02]));
    await expect(opening).rejects.toThrow(/voluntary stream closure/);
  });
});

describe('flow control', () => {
  it('sends DATA packets on the negotiated stream', async () => {
    const { transport, socket, opening } = await begin();
    socket.receive(WISP_CONTINUE, 0, u32le(4));
    await opening;

    await transport.send(new Uint8Array([1, 2, 3]));
    const packet = socket.lastPacket();
    expect(packet.type).toBe(WISP_DATA);
    expect(packet.streamId).toBe(1);
    expect(packet.payload).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('blocks once the window is exhausted and resumes on CONTINUE', async () => {
    const { transport, socket, opening } = await begin();
    socket.receive(WISP_CONTINUE, 0, u32le(2)); // window of 2
    await opening;

    await transport.send(new Uint8Array([1]));
    await transport.send(new Uint8Array([2]));
    expect(socket.packets().filter((p) => p.type === WISP_DATA).length).toBe(2);

    let thirdSent = false;
    const third = transport.send(new Uint8Array([3])).then(() => (thirdSent = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(thirdSent).toBe(false); // window is empty; must not send

    socket.receive(WISP_CONTINUE, 1, u32le(1)); // one slot freed
    await third;
    expect(socket.packets().filter((p) => p.type === WISP_DATA).length).toBe(3);
  });

  it('does not deadlock when the server never advertises a window', async () => {
    const { transport, socket, opening } = await begin();
    socket.receive(WISP_CONTINUE, 0, new Uint8Array(0)); // no buffer_remaining
    await opening;

    await transport.send(new Uint8Array([1]));
    await transport.send(new Uint8Array([2]));
    expect(socket.packets().filter((p) => p.type === WISP_DATA).length).toBe(2);
  });

  it('delivers inbound DATA to the handler', async () => {
    const transport = new WispTransport('wss://relay.example/', 'localhost:3240');
    const chunks: Uint8Array[] = [];
    transport.onData((c) => chunks.push(c));
    const opening = transport.open();
    await Promise.resolve();
    const socket = FakeWebSocket.last!;
    socket.fireOpen();
    await Promise.resolve();
    socket.receive(WISP_CONTINUE, 0, u32le(4));
    await opening;

    socket.receive(WISP_DATA, 1, new Uint8Array([0xaa, 0xbb]));
    expect(chunks).toEqual([new Uint8Array([0xaa, 0xbb])]);
  });
});
