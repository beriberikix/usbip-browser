/**
 * USB/IP over relaynet.
 *
 * Browsers cannot open TCP sockets, and USB/IP is TCP on port 3240.
 * relaynet (https://relaynet.network) carries Ethernet frames over a
 * WebSocket and gives the sessions of one account a private network. Run
 * relaynet-bridge next to usbipd:
 *
 *   relaynet-bridge -expose 3240
 *
 * and a page reaches that usbipd at the address the bridge logs, with no
 * inbound port and no server of your own on the internet.
 *
 * A page has no TCP/IP stack of its own, so this transport brings one: lwIP,
 * compiled to WebAssembly by tcpip.js. The path, end to end:
 *
 *   UsbipClient -> RelaynetTransport -> tcpip.js (TCP <-> Ethernet frames)
 *     -> relaynet's client helper (WebSocket, relay.v1) -> the relay
 *     -> relaynet-bridge -> usbipd
 *
 * The same relay.v1 protocol is served by a self-hosted rootlessRelay
 * (https://github.com/obegron/rootlessRelay), so relaynet is a choice, not a
 * requirement: pass its URL as `url`, with no token if it runs without
 * authentication.
 */
/// <reference path="../types/relaynet.d.ts" />
import { connectRelay, RELAY_URL, type RelayCloseEvent, type RelayConnection } from 'relaynet';
import { createStack } from 'tcpip';
import { requestLease, type DhcpLease } from './dhcp.js';
import type { UsbipTransport } from './types.js';

/** relaynet's hosted relay. */
export const RELAYNET_URL: string = RELAY_URL;

export interface RelaynetTransportOptions {
  /**
   * An API token from relaynet.network. Sessions reach each other only on a
   * beta account, so the token must be one; demo tokens and free accounts
   * cannot reach a bridge. Omit it only for a self-hosted relay that runs
   * without authentication.
   */
  token?: string;
  /** The relay's WebSocket URL. Default: relaynet's, `wss://relay.relaynet.network/`. */
  url?: string;
  /**
   * How long `open()` may take, from the first WebSocket attempt to an
   * established TCP connection (relay, DHCP, then TCP). Default 20000 ms.
   */
  timeoutMs?: number;
  /** Called with a line of text when the relay session drops or comes back. */
  onStatus?: (message: string) => void;
  /** A WebSocket constructor, for Node before 22 or for tests. */
  WebSocket?: unknown;
  /**
   * Let the helper ask relaynet's account API why a connection was refused.
   * Default true. Pages on other origins cannot read that answer (CORS), so
   * the helper skips it there anyway.
   */
  checkToken?: boolean;
}

export class RelaynetError extends Error {
  override name = 'RelaynetError';
  constructor(
    message: string,
    /** The WebSocket close code, when the relay ended the session. */
    readonly code?: number,
  ) {
    super(message);
  }
}

type NetworkStack = Awaited<ReturnType<typeof createStack>>;
type TcpConnection = Awaited<ReturnType<NetworkStack['connectTcp']>>;
type FrameHandler = (frame: Uint8Array) => boolean;

/** Parse "host:port". USB/IP over relaynet is IPv4 only. */
function parseTarget(target: string): { host: string; port: number } {
  const match = /^(?<host>\d{1,3}(?:\.\d{1,3}){3}):(?<port>\d+)$/.exec(target);
  if (!match?.groups) {
    throw new RelaynetError(
      `target must be "a.b.c.d:port", such as the address relaynet-bridge logs; got ${JSON.stringify(target)}`,
    );
  }
  const port = Number(match.groups['port']);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RelaynetError(`invalid port in target ${JSON.stringify(target)}`);
  }
  return { host: match.groups['host']!, port };
}

/** A random unicast, locally administered MAC. */
function randomMac(): Uint8Array {
  const mac = crypto.getRandomValues(new Uint8Array(6));
  mac[0] = (mac[0]! & 0xfe) | 0x02;
  return mac;
}

const macString = (mac: Uint8Array): string =>
  Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join(':');

const asError = (value: unknown): Error =>
  value instanceof Error ? value : new RelaynetError(String(value));

/**
 * Carries one USB/IP TCP stream over relaynet.
 *
 * Each instance owns one relay session, one network stack and one TCP
 * connection; importing N devices means N instances, as USB/IP opens one
 * connection per device. An account has four sessions, and the bridge uses
 * one.
 *
 * If the relay session drops, the helper reconnects and this transport runs
 * DHCP again with the same MAC. relaynet holds the address for 60 s, so a
 * short gap gives it back and the TCP connection carries on; a different
 * address ends the transport with an error.
 */
export class RelaynetTransport implements UsbipTransport {
  #host: string;
  #port: number;
  #options: RelaynetTransportOptions;
  #mac = randomMac();

  #relay: RelayConnection | null = null;
  #stack: NetworkStack | null = null;
  #tapWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  #connection: TcpConnection | null = null;
  #writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  #lease: DhcpLease | null = null;

  /** Raw-link listeners (DHCP); each returns true when it took the frame. */
  #rawHandlers = new Set<FrameHandler>();
  #relayOpen: { resolve: () => void; reject: (e: Error) => void } | null = null;

  #dataHandler: ((chunk: Uint8Array) => void) | null = null;
  #closeHandler: ((cause?: Error) => void) | null = null;
  #opened = false;
  #closed = false;

  /**
   * @param target   the usbipd as seen on the relay's network, such as
   *                 "10.0.2.15:3240" (the address relaynet-bridge logs)
   */
  constructor(target: string, options: RelaynetTransportOptions = {}) {
    const { host, port } = parseTarget(target);
    this.#host = host;
    this.#port = port;
    this.#options = options;
  }

  /** The address this session leased on the relay's network, once open. */
  get address(): string | undefined {
    return this.#lease?.address;
  }

  onData(handler: (chunk: Uint8Array) => void): void {
    this.#dataHandler = handler;
  }

  onClose(handler: (cause?: Error) => void): void {
    this.#closeHandler = handler;
  }

  async open(): Promise<void> {
    if (this.#opened) throw new RelaynetError('transport already opened');
    this.#opened = true;
    const timeoutMs = this.#options.timeoutMs ?? 20_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new RelaynetError(`could not reach ${this.#host}:${this.#port} through the relay within ${timeoutMs} ms`)),
        timeoutMs,
      );
    });
    try {
      await Promise.race([this.#connect(), timeout]);
    } catch (error) {
      this.#teardown();
      this.#closed = true;
      throw asError(error);
    } finally {
      clearTimeout(timer);
    }
  }

  async send(chunk: Uint8Array): Promise<void> {
    if (this.#closed || !this.#writer) throw new RelaynetError('transport is closed');
    await this.#writer.write(chunk);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#connection?.close();
    } catch {
      // Already gone; nothing useful to do.
    }
    this.#teardown();
    this.#closeHandler?.();
  }

  // -- internals -------------------------------------------------------------

  async #connect(): Promise<void> {
    // 1. The relay session.
    await new Promise<void>((resolve, reject) => {
      this.#relayOpen = { resolve, reject };
      this.#relay = connectRelay({
        ...(this.#options.token !== undefined && { token: this.#options.token }),
        url: this.#options.url ?? RELAYNET_URL,
        ...(this.#options.WebSocket !== undefined && { WebSocket: this.#options.WebSocket }),
        ...(this.#options.checkToken !== undefined && { checkToken: this.#options.checkToken }),
        onFrame: (frame) => this.#onFrame(frame),
        onOpen: ({ reconnect }) => {
          if (reconnect) void this.#onReconnect();
          else {
            this.#relayOpen?.resolve();
            this.#relayOpen = null;
          }
        },
        onClose: (event) => this.#onRelayClose(event),
      });
    });

    // 2. An address. relaynet routes between sessions by lease, so a static
    //    address would never hear back from the bridge.
    this.#lease = await this.#requestLease();

    // 3. The stack, on that address and this MAC (the relay locks both).
    const stack = await createStack();
    this.#stack = stack;
    const tap = await stack.interfaces.createTap({
      mac: macString(this.#mac),
      ip: `${this.#lease.address}/${this.#lease.prefixLength}`,
    } as Parameters<NetworkStack['interfaces']['createTap']>[0]);
    tap.readable
      .pipeTo(new WritableStream({ write: (frame) => void this.#relay?.send(frame) }))
      .catch(() => {});
    this.#tapWriter = tap.writable.getWriter();
    if (this.#closed) throw new RelaynetError('transport closed while opening');

    // 4. The TCP connection to usbipd.
    const connection = await stack.connectTcp({ host: this.#host, port: this.#port });
    this.#connection = connection;
    this.#writer = connection.writable.getWriter();
    void this.#readLoop(connection);
  }

  #requestLease(): Promise<DhcpLease> {
    return requestLease(
      this.#mac,
      (frame) => void this.#relay?.send(frame),
      (handler) => {
        this.#rawHandlers.add(handler);
        return () => this.#rawHandlers.delete(handler);
      },
      { timeoutMs: 10_000 },
    );
  }

  #onFrame(frame: Uint8Array): void {
    for (const handler of this.#rawHandlers) if (handler(frame)) return;
    this.#tapWriter?.write(frame).catch(() => {});
  }

  async #readLoop(connection: TcpConnection): Promise<void> {
    // An explicit reader rather than `for await`: async iteration of
    // ReadableStream is recent in Safari.
    const reader = connection.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        this.#dataHandler?.(value);
      }
      this.#finish(); // usbipd hung up
    } catch (error) {
      this.#finish(asError(error));
    } finally {
      reader.releaseLock();
    }
  }

  async #onReconnect(): Promise<void> {
    if (this.#closed || !this.#lease) return;
    const was = this.#lease.address;
    try {
      const lease = await this.#requestLease();
      if (lease.address !== was) {
        this.#finish(
          new RelaynetError(
            `the relay session came back with ${lease.address} instead of ${was}, so the USB/IP connection was lost`,
          ),
        );
        return;
      }
      this.#options.onStatus?.(`relay session restored; still ${was}`);
    } catch (error) {
      this.#finish(new RelaynetError(`could not renew ${was} after the relay reconnected: ${asError(error).message}`));
    }
  }

  #onRelayClose({ code, reason, final }: RelayCloseEvent): void {
    const why = reason ? `${reason} (${code})` : `code ${code}`;
    if (this.#relayOpen) {
      // Still connecting: a final close is a refusal; anything else is retried
      // by the helper until open() times out.
      if (final) {
        this.#relayOpen.reject(new RelaynetError(`the relay refused the session: ${why}`, code));
        this.#relayOpen = null;
      }
      return;
    }
    if (final) this.#finish(new RelaynetError(`the relay ended the session: ${why}`, code));
    else this.#options.onStatus?.(`relay session dropped: ${why}; reconnecting`);
  }

  #finish(cause?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#teardown();
    this.#closeHandler?.(cause);
  }

  #teardown(): void {
    this.#rawHandlers.clear();
    this.#relay?.close();
    this.#relay = null;
    this.#tapWriter?.releaseLock();
    this.#tapWriter = null;
    this.#writer = null;
    this.#stack = null;
  }
}
