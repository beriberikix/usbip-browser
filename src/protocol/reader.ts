/**
 * A byte queue that lets a parser await an exact number of bytes.
 *
 * The transport underneath is a TCP stream tunnelled through WebSocket
 * messages, so a chunk boundary means nothing: one 48-byte URB header can
 * arrive as 48 one-byte chunks, and three headers can arrive as one chunk.
 * Every parse goes through `read(n)`, which resolves only once exactly `n`
 * bytes are available.
 *
 * A single pending reader is supported, which is all the protocol needs --
 * USB/IP framing is strictly sequential on a given connection.
 */
export class ByteReader {
  #chunks: Uint8Array[] = [];
  #available = 0;
  #offset = 0; // consumed bytes within #chunks[0]
  #waiter: { need: number; resolve: (b: Uint8Array) => void; reject: (e: Error) => void } | null =
    null;
  #closed: Error | null = null;

  /** Bytes buffered but not yet consumed. */
  get available(): number {
    return this.#available;
  }

  /** Feed bytes in. Safe to call with a zero-length chunk. */
  push(chunk: Uint8Array): void {
    if (this.#closed) return;
    if (chunk.length === 0) return;
    this.#chunks.push(chunk);
    this.#available += chunk.length;
    this.#pump();
  }

  /**
   * Resolve with exactly `n` bytes, waiting for more data if necessary.
   * Rejects if the reader is closed before `n` bytes arrive.
   */
  read(n: number): Promise<Uint8Array> {
    if (n < 0) throw new RangeError(`read(${n}): length must be non-negative`);
    if (n === 0) return Promise.resolve(new Uint8Array(0));
    if (this.#waiter) {
      return Promise.reject(new Error('ByteReader: concurrent read is not supported'));
    }
    if (this.#available >= n) return Promise.resolve(this.#take(n));
    if (this.#closed) return Promise.reject(this.#closed);

    return new Promise<Uint8Array>((resolve, reject) => {
      this.#waiter = { need: n, resolve, reject };
    });
  }

  /**
   * Close the reader. Any pending read rejects, as do subsequent reads.
   * Buffered-but-unread bytes are discarded.
   */
  close(cause?: Error): void {
    if (this.#closed) return;
    this.#closed = cause ?? new Error('ByteReader: closed');
    const waiter = this.#waiter;
    this.#waiter = null;
    this.#chunks = [];
    this.#available = 0;
    this.#offset = 0;
    waiter?.reject(this.#closed);
  }

  #pump(): void {
    const waiter = this.#waiter;
    if (!waiter || this.#available < waiter.need) return;
    this.#waiter = null;
    waiter.resolve(this.#take(waiter.need));
  }

  /** Precondition: #available >= n, n > 0. */
  #take(n: number): Uint8Array {
    const first = this.#chunks[0]!;

    // Fast path: the request is satisfied entirely by the head chunk. Subarray
    // is a view, so this copies nothing.
    if (first.length - this.#offset >= n) {
      const out = first.subarray(this.#offset, this.#offset + n);
      this.#offset += n;
      this.#available -= n;
      if (this.#offset === first.length) {
        this.#chunks.shift();
        this.#offset = 0;
      }
      return out;
    }

    // Slow path: stitch across chunk boundaries.
    const out = new Uint8Array(n);
    let written = 0;
    while (written < n) {
      const chunk = this.#chunks[0]!;
      const from = chunk.subarray(this.#offset);
      const want = n - written;
      if (from.length <= want) {
        out.set(from, written);
        written += from.length;
        this.#chunks.shift();
        this.#offset = 0;
      } else {
        out.set(from.subarray(0, want), written);
        this.#offset += want;
        written = n;
      }
    }
    this.#available -= n;
    return out;
  }
}
