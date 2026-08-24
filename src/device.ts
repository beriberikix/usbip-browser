import type { UsbipClient } from './client.js';
import { encodeSetupPacket } from './protocol/codec.js';
import { USB_REQUEST } from './protocol/constants.js';
import type { UsbipDeviceInfo } from './protocol/types.js';

/** WebUSB-compatible control transfer parameters. */
export interface UsbipControlTransferParameters {
  requestType: 'standard' | 'class' | 'vendor';
  recipient: 'device' | 'interface' | 'endpoint' | 'other';
  request: number;
  value: number;
  index: number;
}

export interface UsbipInTransferResult {
  data: DataView;
  status: 'ok';
}

export interface UsbipOutTransferResult {
  bytesWritten: number;
  status: 'ok';
}

const REQUEST_TYPE_BITS = { standard: 0, class: 1, vendor: 2 } as const;
const RECIPIENT_BITS = { device: 0, interface: 1, endpoint: 2, other: 3 } as const;

function bmRequestType(
  dirIn: boolean,
  setup: Pick<UsbipControlTransferParameters, 'requestType' | 'recipient'>,
): number {
  return (
    (dirIn ? 0x80 : 0x00) |
    (REQUEST_TYPE_BITS[setup.requestType] << 5) |
    RECIPIENT_BITS[setup.recipient]
  );
}

const NO_SETUP = new Uint8Array(8);

/**
 * A remote USB device, imported over USB/IP.
 *
 * The API mirrors WebUSB's `USBDevice` so that code written against
 * `navigator.usb` ports over with minimal edits. The semantics differ in one
 * important way: `usbip bind` already detached the kernel driver on the
 * exporting host, so we own the device outright and are responsible for
 * configuring it ourselves over endpoint 0.
 */
export class UsbipDevice {
  #client: UsbipClient;
  #devid: number;
  #configuration: number | null = null;
  #claimed = new Set<number>();

  constructor(
    client: UsbipClient,
    readonly info: UsbipDeviceInfo,
    devid: number,
  ) {
    this.#client = client;
    this.#devid = devid;
  }

  get vendorId(): number {
    return this.info.vendorId;
  }
  get productId(): number {
    return this.info.productId;
  }
  get busid(): string {
    return this.info.busid;
  }
  get configurationValue(): number | null {
    return this.#configuration;
  }

  /** Issue SET_CONFIGURATION. Unlike WebUSB, this really goes to the device. */
  async selectConfiguration(configurationValue: number): Promise<void> {
    await this.controlTransferOut({
      requestType: 'standard',
      recipient: 'device',
      request: USB_REQUEST.SET_CONFIGURATION,
      value: configurationValue,
      index: 0,
    });
    this.#configuration = configurationValue;
  }

  /**
   * Bookkeeping only, kept for WebUSB API parity. There is no local kernel
   * driver to contend with -- the exporting host already unbound it -- so
   * there is nothing to claim against.
   */
  async claimInterface(interfaceNumber: number): Promise<void> {
    this.#claimed.add(interfaceNumber);
  }

  async releaseInterface(interfaceNumber: number): Promise<void> {
    this.#claimed.delete(interfaceNumber);
  }

  /** Issue SET_INTERFACE for an alternate setting. */
  async selectAlternateInterface(interfaceNumber: number, alternateSetting: number): Promise<void> {
    await this.controlTransferOut({
      requestType: 'standard',
      recipient: 'interface',
      request: USB_REQUEST.SET_INTERFACE,
      value: alternateSetting,
      index: interfaceNumber,
    });
  }

  async controlTransferIn(
    setup: UsbipControlTransferParameters,
    length: number,
    signal?: AbortSignal,
  ): Promise<UsbipInTransferResult> {
    const packet = encodeSetupPacket(
      bmRequestType(true, setup),
      setup.request,
      setup.value,
      setup.index,
      length,
    );
    const { data } = await this.#client.submit(
      0,
      true,
      {
        transferFlags: 0,
        transferBufferLength: length,
        startFrame: 0,
        numberOfPackets: -1,
        interval: 0,
        setup: packet,
      },
      undefined,
      this.#devid,
      signal,
    );
    return { data: new DataView(data.buffer, data.byteOffset, data.byteLength), status: 'ok' };
  }

  async controlTransferOut(
    setup: UsbipControlTransferParameters,
    data?: Uint8Array,
    signal?: AbortSignal,
  ): Promise<UsbipOutTransferResult> {
    const payload = data ?? new Uint8Array(0);
    const packet = encodeSetupPacket(
      bmRequestType(false, setup),
      setup.request,
      setup.value,
      setup.index,
      payload.length,
    );
    await this.#client.submit(
      0,
      false,
      {
        transferFlags: 0,
        transferBufferLength: payload.length,
        startFrame: 0,
        numberOfPackets: -1,
        interval: 0,
        setup: packet,
      },
      payload,
      this.#devid,
      signal,
    );
    return { bytesWritten: payload.length, status: 'ok' };
  }

  /** Bulk or interrupt IN. `endpointNumber` is the address without the direction bit. */
  async transferIn(
    endpointNumber: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<UsbipInTransferResult> {
    const { data } = await this.#client.submit(
      endpointNumber,
      true,
      {
        transferFlags: 0,
        transferBufferLength: length,
        startFrame: 0,
        numberOfPackets: -1,
        interval: 0,
        setup: NO_SETUP,
      },
      undefined,
      this.#devid,
      signal,
    );
    return { data: new DataView(data.buffer, data.byteOffset, data.byteLength), status: 'ok' };
  }

  /** Bulk or interrupt OUT. */
  async transferOut(
    endpointNumber: number,
    data: Uint8Array,
    signal?: AbortSignal,
  ): Promise<UsbipOutTransferResult> {
    await this.#client.submit(
      endpointNumber,
      false,
      {
        transferFlags: 0,
        transferBufferLength: data.length,
        startFrame: 0,
        numberOfPackets: -1,
        interval: 0,
        setup: NO_SETUP,
      },
      data,
      this.#devid,
      signal,
    );
    return { bytesWritten: data.length, status: 'ok' };
  }

  /** CLEAR_FEATURE(ENDPOINT_HALT) -- clears a stall. */
  async clearHalt(direction: 'in' | 'out', endpointNumber: number): Promise<void> {
    await this.controlTransferOut({
      requestType: 'standard',
      recipient: 'endpoint',
      request: 0x01, // CLEAR_FEATURE
      value: 0x00, // ENDPOINT_HALT
      index: endpointNumber | (direction === 'in' ? 0x80 : 0x00),
    });
  }

  async close(): Promise<void> {
    await this.#client.close();
  }
}
