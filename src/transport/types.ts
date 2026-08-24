/**
 * A bidirectional byte pipe carrying one TCP stream.
 *
 * This is the whole seam between the USB/IP protocol and however you reach
 * port 3240. It is deliberately tiny so that alternative bridges -- an
 * epoxy-tls WASM stream for end-to-end TLS, a Direct Sockets `TCPSocket` in
 * an Isolated Web App, an in-process mock -- can be dropped in without
 * touching the protocol code.
 *
 * Implementations must preserve byte order and completeness, but are under
 * no obligation to preserve chunk boundaries; the parser handles arbitrary
 * splitting via ByteReader.
 */
export interface UsbipTransport {
  /** Establish the connection. Resolves once bytes can flow. */
  open(): Promise<void>;

  /** Queue bytes for transmission, applying any flow control. */
  send(chunk: Uint8Array): Promise<void>;

  /** Register the data callback. Called at most once, before `open()`. */
  onData(handler: (chunk: Uint8Array) => void): void;

  /** Register the close callback. `cause` is set for abnormal termination. */
  onClose(handler: (cause?: Error) => void): void;

  /** Close the connection. Idempotent. */
  close(): Promise<void>;
}
