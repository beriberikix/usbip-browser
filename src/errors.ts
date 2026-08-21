/** Base class for every error this library throws. */
export class UsbipError extends Error {
  override name = 'UsbipError';
}

/** The server rejected an op-phase request (DEVLIST / IMPORT). */
export class UsbipProtocolError extends UsbipError {
  override name = 'UsbipProtocolError';
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/**
 * A URB completed with a non-zero status.
 *
 * USB/IP reports the kernel's negated errno, so -32 (EPIPE) is the usual way
 * a stalled endpoint surfaces. `stalled` is the common case worth branching
 * on; everything else is better read from `status`.
 */
export class UsbipTransferError extends UsbipError {
  override name = 'UsbipTransferError';
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }

  /** True when the device stalled the endpoint (-EPIPE). */
  get stalled(): boolean {
    return this.status === -32;
  }
}

/** The connection closed underneath an in-flight operation. */
export class UsbipClosedError extends UsbipError {
  override name = 'UsbipClosedError';
}
