/**
 * CDC-ACM (USB communications class, abstract control model) over USB/IP.
 *
 * This is the layer that turns URB submit/reply into something stream-shaped,
 * which is what a terminal emulator or any serial consumer actually wants.
 */
import type { UsbipDevice } from '../device.js';
import { UsbipTransferError } from '../errors.js';

/** CDC class-specific requests, from the CDC 1.2 specification. */
const CDC_SET_LINE_CODING = 0x20;
const CDC_SET_CONTROL_LINE_STATE = 0x22;

/** Interface classes that identify the two halves of a CDC-ACM function. */
export const CDC_COMM_CLASS = 0x02;
export const CDC_DATA_CLASS = 0x0a;
export const CDC_ACM_SUBCLASS = 0x02;

export type Parity = 'none' | 'odd' | 'even' | 'mark' | 'space';
export type StopBits = 1 | 1.5 | 2;

const PARITY_CODES: Record<Parity, number> = { none: 0, odd: 1, even: 2, mark: 3, space: 4 };
const STOP_BIT_CODES: Record<string, number> = { '1': 0, '1.5': 1, '2': 2 };

/** Consecutive stalls tolerated before the read stream gives up. */
const MAX_CONSECUTIVE_STALLS = 8;

/**
 * Close a stream controller that may already be closed.
 *
 * When the consumer cancels, the stream is already in the closed state by the
 * time our in-flight `transferIn` rejects with AbortError, and calling
 * `close()` then throws a TypeError.
 */
function closeSafely(controller: ReadableStreamDefaultController<Uint8Array>): void {
  try {
    controller.close();
  } catch {
    // Already closed by cancellation.
  }
}

export interface CdcAcmOptions {
  /** Bits per second. Default 115200. */
  baudRate?: number;
  /** Data bits per frame. Default 8. */
  dataBits?: 5 | 6 | 7 | 8;
  /** Default 1. */
  stopBits?: StopBits;
  /** Default 'none'. */
  parity?: Parity;
  /**
   * Configuration to select before use. Defaults to the device's current
   * configuration, or 1 when it reports none -- which is what usbipd reports
   * for any device it has just bound.
   */
  configurationValue?: number;
  /** Control (communications) interface number. Default 0. */
  controlInterface?: number;
  /** Data interface number. Default 1. */
  dataInterface?: number;
  /** Bulk IN endpoint number, without the direction bit. Default 2. */
  endpointIn?: number;
  /** Bulk OUT endpoint number. Default 1. */
  endpointOut?: number;
  /** Bytes requested per read. Default 64. */
  readSize?: number;
}

/**
 * Build the 7-byte SET_LINE_CODING payload.
 *
 * dwDTERate is little-endian here -- this is a USB class payload, not a
 * USB/IP structure.
 */
export function encodeLineCoding(
  baudRate: number,
  stopBits: StopBits,
  parity: Parity,
  dataBits: number,
): Uint8Array {
  const out = new Uint8Array(7);
  const view = new DataView(out.buffer);
  view.setUint32(0, baudRate, true);
  view.setUint8(4, STOP_BIT_CODES[String(stopBits)] ?? 0);
  view.setUint8(5, PARITY_CODES[parity]);
  view.setUint8(6, dataBits);
  return out;
}

/**
 * A CDC-ACM serial port backed by a USB/IP device.
 *
 * ```ts
 * const port = await CdcAcmDevice.open(device, { baudRate: 115200 });
 * port.readable.pipeTo(someSink);
 * const writer = port.writable.getWriter();
 * await writer.write(new TextEncoder().encode('hello\r'));
 * ```
 */
export class CdcAcmDevice {
  #device: UsbipDevice;
  #options: Required<Omit<CdcAcmOptions, 'configurationValue'>> & { configurationValue: number };
  #reading = false;
  #closed = false;
  #abort = new AbortController();

  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;

  private constructor(device: UsbipDevice, options: CdcAcmOptions) {
    this.#device = device;
    this.#options = {
      baudRate: options.baudRate ?? 115200,
      dataBits: options.dataBits ?? 8,
      stopBits: options.stopBits ?? 1,
      parity: options.parity ?? 'none',
      // A device that usbipd has just bound is UNCONFIGURED, so it reports
      // bConfigurationValue = 0. Zero is not a selectable configuration -- it
      // is the standard request to *unconfigure* a device -- so `??` is wrong
      // here and 0 must fall through to 1.
      configurationValue: options.configurationValue || device.info.configurationValue || 1,
      controlInterface: options.controlInterface ?? 0,
      dataInterface: options.dataInterface ?? 1,
      endpointIn: options.endpointIn ?? 2,
      endpointOut: options.endpointOut ?? 1,
      readSize: options.readSize ?? 64,
    };

    this.readable = new ReadableStream<Uint8Array>({
      // A `pull` that returns without enqueuing is treated by the stream as
      // satisfied, and it will not be called again until the next read --
      // which never comes, because the consumer is already waiting. So this
      // must not return until it has actually produced data.
      //
      // That matters because both non-productive outcomes happen routinely on
      // real hardware: an ESP32-C3 boot log arrives as 32 data packets
      // interleaved with 9 zero-length completions, and endpoints stall.
      // Returning on either one stalls the stream permanently.
      pull: async (controller) => {
        let stalls = 0;
        while (!this.#closed) {
          try {
            const result = await this.#device.transferIn(
              this.#options.endpointIn,
              this.#options.readSize,
              this.#abort.signal,
            );
            const bytes = new Uint8Array(
              result.data.buffer,
              result.data.byteOffset,
              result.data.byteLength,
            );
            // Zero length is a short-packet/idle completion, not end of
            // stream. Keep waiting for real data.
            if (bytes.length > 0) {
              controller.enqueue(bytes.slice());
              return;
            }
            stalls = 0;
          } catch (error) {
            if (this.#closed || (error instanceof Error && error.name === 'AbortError')) {
              closeSafely(controller);
              return;
            }
            // A stalled IN endpoint is usually transient: clear it and retry.
            // A device that stalls every attempt is not, so give up rather
            // than retry forever.
            if (error instanceof UsbipTransferError && error.stalled) {
              if (++stalls <= MAX_CONSECUTIVE_STALLS) {
                await this.#device.clearHalt('in', this.#options.endpointIn).catch(() => {});
                continue;
              }
              controller.error(
                new UsbipTransferError(
                  `endpoint ${this.#options.endpointIn} stalled ${stalls} times in a row`,
                  error.status,
                ),
              );
              return;
            }
            controller.error(error);
            return;
          }
        }
        closeSafely(controller);
      },
      cancel: () => {
        this.#abort.abort();
      },
    });

    this.writable = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        if (this.#closed) throw new Error('CdcAcmDevice is closed');
        await this.#device.transferOut(this.#options.endpointOut, chunk, this.#abort.signal);
      },
      close: () => {
        this.#abort.abort();
      },
      abort: () => {
        this.#abort.abort();
      },
    });
  }

  /**
   * Configure the device and return a ready port.
   *
   * The sequence matters: SET_CONFIGURATION must precede the class requests,
   * and DTR/RTS must be asserted or many adapters stay mute.
   */
  static async open(device: UsbipDevice, options: CdcAcmOptions = {}): Promise<CdcAcmDevice> {
    const port = new CdcAcmDevice(device, options);
    const o = port.#options;

    await device.selectConfiguration(o.configurationValue);
    await device.claimInterface(o.controlInterface);
    await device.claimInterface(o.dataInterface);

    await device.controlTransferOut(
      {
        requestType: 'class',
        recipient: 'interface',
        request: CDC_SET_LINE_CODING,
        value: 0,
        index: o.controlInterface,
      },
      encodeLineCoding(o.baudRate, o.stopBits, o.parity, o.dataBits),
    );

    await port.setControlLineState({ dtr: true, rts: true });
    return port;
  }

  /** Assert or clear DTR and RTS. */
  async setControlLineState({ dtr = false, rts = false }: { dtr?: boolean; rts?: boolean }): Promise<void> {
    await this.#device.controlTransferOut({
      requestType: 'class',
      recipient: 'interface',
      request: CDC_SET_CONTROL_LINE_STATE,
      value: (dtr ? 0x01 : 0) | (rts ? 0x02 : 0),
      index: this.#options.controlInterface,
    });
  }

  get device(): UsbipDevice {
    return this.#device;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#abort.abort();
    await this.setControlLineState({ dtr: false, rts: false }).catch(() => {});
  }
}

/**
 * Find the CDC-ACM control and data interface numbers in a device listing.
 * Returns null when the device does not look like a CDC-ACM function.
 */
export function findCdcAcmInterfaces(
  interfaces: ReadonlyArray<{ interfaceClass: number; interfaceSubClass: number }>,
): { controlInterface: number; dataInterface: number } | null {
  const control = interfaces.findIndex(
    (i) => i.interfaceClass === CDC_COMM_CLASS && i.interfaceSubClass === CDC_ACM_SUBCLASS,
  );
  const data = interfaces.findIndex((i) => i.interfaceClass === CDC_DATA_CLASS);
  if (control === -1 || data === -1) return null;
  return { controlInterface: control, dataInterface: data };
}
