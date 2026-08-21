/**
 * A WISP v2 client, with automatic fallback to v1.
 *
 * Written from the specification rather than taken as a dependency: the only
 * off-the-shelf browser client (@mercuryworkshop/wisp-js) is AGPL-3.0, which
 * would propagate to every application embedding this Apache-2.0 library.
 *
 * Spec: https://github.com/MercuryWorkshop/wisp-protocol (v2 branch)
 *
 * Endianness warning: every WISP field is LITTLE-endian. USB/IP, which rides
 * directly on top of it, is big-endian. The two codecs are kept in separate
 * modules for exactly this reason.
 */
import type { UsbipTransport } from './types.js';

// -- packet types ------------------------------------------------------------

export const WISP_CONNECT = 0x01;
export const WISP_DATA = 0x02;
export const WISP_CONTINUE = 0x03;
export const WISP_CLOSE = 0x04;
export const WISP_INFO = 0x05;

export const WISP_STREAM_TCP = 0x01;
export const WISP_STREAM_UDP = 0x02;

/** Extension IDs defined by v2. */
export const WISP_EXT = {
  UDP: 0x01,
  PASSWORD_AUTH: 0x02,
  KEY_AUTH: 0x03,
  MOTD: 0x04,
  STREAM_OPEN_CONFIRMATION: 0x05,
} as const;

/** Close reasons worth naming; anything else surfaces as its raw code. */
const CLOSE_REASONS: Record<number, string> = {
  0x01: 'unspecified error',
  0x02: 'voluntary stream closure',
  0x03: 'network error',
  0x04: 'incompatible extensions',
  0x41: 'stream creation failed: unreachable',
  0x42: 'stream creation failed: connection timed out',
  0x43: 'stream creation failed: connection refused',
  0x47: 'stream creation failed: destination blocked',
  0x48: 'stream creation failed: throttled',
  0xc0: 'password authentication failed',
  0xc1: 'signature verification failed',
  0xc2: 'credentials required',
};

export class WispError extends Error {
  override name = 'WispError';
  constructor(
    message: string,
    readonly reason?: number,
  ) {
    super(message);
  }
}

interface WispPacket {
  type: number;
  streamId: number;
  payload: Uint8Array;
}

const LE = true;
const HEADER_SIZE = 5;

function encodePacket(type: number, streamId: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER_SIZE + payload.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, type);
  view.setUint32(1, streamId, LE);
  out.set(payload, HEADER_SIZE);
  return out;
}

function decodePacket(bytes: Uint8Array): WispPacket {
  if (bytes.length < HEADER_SIZE) {
    throw new WispError(`packet too short: ${bytes.length} bytes`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    type: view.getUint8(0),
    streamId: view.getUint32(1, LE),
    payload: bytes.subarray(HEADER_SIZE),
  };
}

export interface WispExtension {
  id: number;
  payload: Uint8Array;
}

/** Extension entry: id u8, payload length u32, then metadata. */
function decodeExtensions(bytes: Uint8Array): WispExtension[] {
  const out: WispExtension[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  while (o + 5 <= bytes.length) {
    const id = view.getUint8(o);
    const length = view.getUint32(o + 1, LE);
    o += 5;
    if (o + length > bytes.length) {
      throw new WispError(`extension 0x${id.toString(16)} claims ${length} bytes past the packet`);
    }
    out.push({ id, payload: bytes.subarray(o, o + length) });
    o += length;
  }
  return out;
}

function encodeExtensions(extensions: WispExtension[]): Uint8Array {
  const total = extensions.reduce((n, e) => n + 5 + e.payload.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let o = 0;
  for (const ext of extensions) {
    view.setUint8(o, ext.id);
    view.setUint32(o + 1, ext.payload.length, LE);
    out.set(ext.payload, o + 5);
    o += 5 + ext.payload.length;
  }
  return out;
}

function encodeInfo(major: number, minor: number, extensions: WispExtension[]): Uint8Array {
  const ext = encodeExtensions(extensions);
  const payload = new Uint8Array(2 + ext.length);
  payload[0] = major;
  payload[1] = minor;
  payload.set(ext, 2);
  return encodePacket(WISP_INFO, 0, payload);
}

function encodeConnect(streamId: number, host: string, port: number): Uint8Array {
  const hostBytes = new TextEncoder().encode(host);
  const payload = new Uint8Array(3 + hostBytes.length);
  const view = new DataView(payload.buffer);
  view.setUint8(0, WISP_STREAM_TCP);
  view.setUint16(1, port, LE);
  payload.set(hostBytes, 3);
  return encodePacket(WISP_CONNECT, streamId, payload);
}

// -- transport ---------------------------------------------------------------

export interface WispTransportOptions {
  /**
   * WebSocket subprotocols to advertise.
   *
   * Defaults to none, which is the only interoperable choice. The v2 spec
   * says a `Sec-WebSocket-Protocol` header signals v2 support but does not
   * fix a token, and wisp-server-python 0.9.0 fails the WebSocket handshake
   * outright when *any* subprotocol is requested. Since a server that does
   * not send INFO first is handled by the v1 fallback anyway, advertising
   * nothing costs nothing and works everywhere.
   *
   * Set this only against a server known to require a particular token.
   */
  subprotocols?: string[];
  /** Credentials for the password-auth extension (0x02). */
  auth?: { username: string; password: string };
  /** Handshake timeout in milliseconds. Default 10000. */
  timeoutMs?: number;
  /** Invoked with the server's MOTD when extension 0x04 is offered. */
  onMotd?: (motd: string) => void;
}

/** Parse "host:port", tolerating bracketed IPv6 literals. */
function parseTarget(target: string): { host: string; port: number } {
  const match = /^(?:\[(?<v6>[^\]]+)\]|(?<host>[^:]+)):(?<port>\d+)$/.exec(target);
  if (!match?.groups) throw new WispError(`target must be "host:port", got ${JSON.stringify(target)}`);
  const port = Number(match.groups['port']);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new WispError(`invalid port in target ${JSON.stringify(target)}`);
  }
  return { host: match.groups['v6'] ?? match.groups['host']!, port };
}

/**
 * Carries one USB/IP TCP stream over a WISP connection.
 *
 * Each instance owns its own WebSocket and a single WISP stream. USB/IP opens
 * one TCP connection per imported device, so importing N devices means N
 * instances -- WISP multiplexing across one socket is possible but not worth
 * the shared-lifetime complexity here.
 */
export class WispTransport implements UsbipTransport {
  #url: string;
  #host: string;
  #port: number;
  #options: WispTransportOptions;

  #socket: WebSocket | null = null;
  #dataHandler: ((chunk: Uint8Array) => void) | null = null;
  #closeHandler: ((cause?: Error) => void) | null = null;

  #streamId = 1;
  #version = 1;
  #extensions = new Set<number>();

  /**
   * Remaining server-side buffer slots, decremented once per DATA packet.
   * Starts at Infinity so that a server which never sends CONTINUE cannot
   * deadlock us; the first CONTINUE switches us into real accounting.
   */
  #window = Number.POSITIVE_INFINITY;
  #initialWindow = Number.POSITIVE_INFINITY;
  #windowWaiters: Array<() => void> = [];

  #opened = false;
  #closed = false;
  #handshake: {
    resolve: () => void;
    reject: (e: Error) => void;
    stage: 'awaiting-info' | 'awaiting-accept' | 'awaiting-stream';
  } | null = null;

  constructor(url: string, target: string, options: WispTransportOptions = {}) {
    this.#url = url;
    const { host, port } = parseTarget(target);
    this.#host = host;
    this.#port = port;
    this.#options = options;
  }

  /** Negotiated protocol version: 1 or 2. Meaningful only after `open()`. */
  get version(): number {
    return this.#version;
  }

  /** Extension IDs active on this connection. */
  get negotiatedExtensions(): ReadonlySet<number> {
    return this.#extensions;
  }

  onData(handler: (chunk: Uint8Array) => void): void {
    this.#dataHandler = handler;
  }

  onClose(handler: (cause?: Error) => void): void {
    this.#closeHandler = handler;
  }

  async open(): Promise<void> {
    if (this.#opened) throw new WispError('transport already opened');
    this.#opened = true;

    const timeoutMs = this.#options.timeoutMs ?? 10_000;
    const subprotocols = this.#options.subprotocols ?? [];

    const socket = new WebSocket(this.#url, subprotocols);
    socket.binaryType = 'arraybuffer';
    this.#socket = socket;

    const handshake = new Promise<void>((resolve, reject) => {
      this.#handshake = { resolve, reject, stage: 'awaiting-info' };
    });

    socket.addEventListener('message', (event) => this.#onMessage(event));
    socket.addEventListener('error', () => {
      this.#fail(new WispError(`WebSocket error connecting to ${this.#url}`));
    });
    socket.addEventListener('close', (event) => {
      this.#fail(
        new WispError(
          `WebSocket closed (code ${event.code}${event.reason ? `: ${event.reason}` : ''})`,
        ),
      );
    });

    await new Promise<void>((resolve, reject) => {
      if (socket.readyState === WebSocket.OPEN) return resolve();
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new WispError('WebSocket failed to open')), {
        once: true,
      });
    });

    // A v1 server sends CONTINUE first and never an INFO. We cannot know which
    // we are talking to until a packet arrives, so both paths are driven from
    // #onMessage and settle this promise.
    await this.#withTimeout(handshake, timeoutMs, 'WISP handshake');
  }

  async send(chunk: Uint8Array): Promise<void> {
    if (this.#closed) throw new WispError('transport is closed');
    await this.#acquireWindowSlot();
    this.#raw(encodePacket(WISP_DATA, this.#streamId, chunk));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const socket = this.#socket;
    if (socket && socket.readyState === WebSocket.OPEN) {
      try {
        this.#raw(encodePacket(WISP_CLOSE, this.#streamId, new Uint8Array([0x02])));
      } catch {
        // Socket already going away; nothing useful to do.
      }
      socket.close();
    }
    this.#releaseAllWaiters();
    this.#closeHandler?.();
  }

  // -- internals -------------------------------------------------------------

  #raw(bytes: Uint8Array): void {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new WispError('WebSocket is not open');
    }
    socket.send(bytes);
  }

  /** Block until the server has a buffer slot for one more DATA packet. */
  async #acquireWindowSlot(): Promise<void> {
    while (this.#window <= 0) {
      if (this.#closed) throw new WispError('transport closed while awaiting flow control');
      await new Promise<void>((resolve) => this.#windowWaiters.push(resolve));
    }
    this.#window -= 1;
  }

  #releaseAllWaiters(): void {
    const waiters = this.#windowWaiters;
    this.#windowWaiters = [];
    for (const w of waiters) w();
  }

  #onMessage(event: MessageEvent): void {
    if (!(event.data instanceof ArrayBuffer)) return;
    let packet: WispPacket;
    try {
      packet = decodePacket(new Uint8Array(event.data));
    } catch (error) {
      this.#fail(error instanceof Error ? error : new WispError(String(error)));
      return;
    }

    switch (packet.type) {
      case WISP_INFO:
        this.#onInfo(packet);
        return;
      case WISP_CONTINUE:
        this.#onContinue(packet);
        return;
      case WISP_DATA:
        // Copy: the ArrayBuffer backing this view is not ours to retain.
        this.#dataHandler?.(packet.payload.slice());
        return;
      case WISP_CLOSE:
        this.#onClosePacket(packet);
        return;
      default:
        // Unknown packet types are ignored rather than fatal, so that a newer
        // server can add types without breaking us.
        return;
    }
  }

  #onInfo(packet: WispPacket): void {
    if (packet.payload.length < 2) {
      this.#fail(new WispError('INFO packet shorter than 2 bytes'));
      return;
    }
    this.#version = packet.payload[0]!;

    let offered: WispExtension[];
    try {
      offered = decodeExtensions(packet.payload.subarray(2));
    } catch (error) {
      this.#fail(error instanceof Error ? error : new WispError(String(error)));
      return;
    }

    const ours: WispExtension[] = [];
    let passwordRequired = false;
    let keyRequired = false;

    for (const ext of offered) {
      switch (ext.id) {
        case WISP_EXT.STREAM_OPEN_CONFIRMATION:
          // Worth taking whenever offered: USB/IP speaks first, so without
          // this a wrong host or an unbound usbipd looks like a hang rather
          // than an error.
          this.#extensions.add(ext.id);
          ours.push({ id: ext.id, payload: new Uint8Array(0) });
          break;
        case WISP_EXT.MOTD:
          this.#options.onMotd?.(new TextDecoder().decode(ext.payload));
          break;
        case WISP_EXT.PASSWORD_AUTH:
          passwordRequired = ext.payload[0] === 1;
          break;
        case WISP_EXT.KEY_AUTH:
          keyRequired = ext.payload[0] === 1;
          break;
        default:
          break; // UDP and anything unrecognised: not useful to USB/IP.
      }
    }

    if (passwordRequired || this.#options.auth) {
      const auth = this.#options.auth;
      if (!auth) {
        this.#fail(new WispError('server requires password authentication but no auth was provided', 0xc2));
        return;
      }
      const username = new TextEncoder().encode(auth.username);
      const password = new TextEncoder().encode(auth.password);
      if (username.length > 255) {
        this.#fail(new WispError('username exceeds 255 bytes'));
        return;
      }
      const payload = new Uint8Array(1 + username.length + password.length);
      payload[0] = username.length;
      payload.set(username, 1);
      payload.set(password, 1 + username.length);
      this.#extensions.add(WISP_EXT.PASSWORD_AUTH);
      ours.push({ id: WISP_EXT.PASSWORD_AUTH, payload });
    } else if (keyRequired) {
      this.#fail(
        new WispError('server requires key authentication, which this client does not implement', 0xc2),
      );
      return;
    }

    try {
      this.#raw(encodeInfo(2, 0, ours));
    } catch (error) {
      this.#fail(error instanceof Error ? error : new WispError(String(error)));
      return;
    }
    if (this.#handshake) this.#handshake.stage = 'awaiting-accept';
  }

  #onContinue(packet: WispPacket): void {
    const remaining =
      packet.payload.length >= 4
        ? new DataView(
            packet.payload.buffer,
            packet.payload.byteOffset,
            packet.payload.byteLength,
          ).getUint32(0, LE)
        : undefined;

    const handshake = this.#handshake;

    // A CONTINUE arriving before any INFO means the server is v1.
    if (handshake?.stage === 'awaiting-info') {
      this.#version = 1;
      if (remaining !== undefined) {
        this.#initialWindow = remaining;
        this.#window = remaining;
      }
      this.#beginStream();
      return;
    }

    if (handshake?.stage === 'awaiting-accept') {
      // v2 acceptance, on stream 0.
      if (remaining !== undefined) {
        this.#initialWindow = remaining;
        this.#window = remaining;
      }
      this.#beginStream();
      return;
    }

    if (handshake?.stage === 'awaiting-stream' && packet.streamId === this.#streamId) {
      // Stream-open confirmation: the TCP socket is genuinely connected.
      if (remaining !== undefined) this.#window = remaining;
      this.#settle();
      return;
    }

    // Steady state. A v2 server sends these proactively, not only when a
    // buffer fills, so an unsolicited CONTINUE is normal.
    if (packet.streamId === this.#streamId && remaining !== undefined) {
      this.#window = remaining;
      this.#releaseAllWaiters();
    } else if (packet.streamId === 0 && remaining !== undefined) {
      this.#initialWindow = remaining;
    }
  }

  /** Send CONNECT and either wait for confirmation or proceed optimistically. */
  #beginStream(): void {
    try {
      this.#raw(encodeConnect(this.#streamId, this.#host, this.#port));
    } catch (error) {
      this.#fail(error instanceof Error ? error : new WispError(String(error)));
      return;
    }
    if (this.#window === Number.POSITIVE_INFINITY && this.#initialWindow !== Number.POSITIVE_INFINITY) {
      this.#window = this.#initialWindow;
    }

    if (this.#extensions.has(WISP_EXT.STREAM_OPEN_CONFIRMATION)) {
      if (this.#handshake) this.#handshake.stage = 'awaiting-stream';
      return; // resolved by the stream's CONTINUE
    }
    // No confirmation available: the socket may still be connecting. The
    // USB/IP layer's own op-phase timeout is the backstop here.
    this.#settle();
  }

  #onClosePacket(packet: WispPacket): void {
    const reason = packet.payload[0] ?? 0;
    const description = CLOSE_REASONS[reason] ?? `reason 0x${reason.toString(16)}`;
    const error = new WispError(`WISP stream closed: ${description}`, reason);
    this.#fail(error);
  }

  #settle(): void {
    const handshake = this.#handshake;
    this.#handshake = null;
    handshake?.resolve();
  }

  #fail(error: Error): void {
    const handshake = this.#handshake;
    this.#handshake = null;
    this.#releaseAllWaiters();

    if (handshake) {
      this.#closed = true;
      handshake.reject(error);
      return;
    }
    if (this.#closed) return;
    this.#closed = true;
    this.#closeHandler?.(error);
  }

  async #withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    if (ms <= 0) return promise;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new WispError(`${what} timed out after ${ms}ms`)), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
