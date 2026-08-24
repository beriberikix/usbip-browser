import type { UsbSpeed } from './constants.js';

/** One interface descriptor summary, as carried in OP_REP_DEVLIST. */
export interface UsbipInterface {
  interfaceClass: number;
  interfaceSubClass: number;
  interfaceProtocol: number;
}

/** A device as described by `usbip_usb_device` (312 bytes on the wire). */
export interface UsbipDeviceInfo {
  path: string;
  busid: string;
  busnum: number;
  devnum: number;
  speed: UsbSpeed;
  vendorId: number;
  productId: number;
  bcdDevice: number;
  deviceClass: number;
  deviceSubClass: number;
  deviceProtocol: number;
  /**
   * The device's *current* configuration, which is **0 for any device usbipd
   * has just bound** -- binding leaves it unconfigured. Zero is not a
   * selectable value; pass 1 (or a value read from the configuration
   * descriptor) to `selectConfiguration`.
   */
  configurationValue: number;
  numConfigurations: number;
  /** Interfaces in the *current* configuration, hence 0 while unconfigured. */
  numInterfaces: number;
  /**
   * Populated by OP_REP_DEVLIST; empty after OP_REP_IMPORT, which omits them.
   * Also empty for an unconfigured device -- read the configuration
   * descriptor over endpoint 0 if you need the real interface list.
   */
  interfaces: UsbipInterface[];
}

/** Shared 20-byte prefix of every URB-phase header. */
export interface UsbipHeaderBasic {
  command: number;
  seqnum: number;
  devid: number;
  direction: number;
  ep: number;
}

export interface CmdSubmit {
  transferFlags: number;
  transferBufferLength: number;
  startFrame: number;
  numberOfPackets: number;
  interval: number;
  /** Raw 8-byte USB setup packet, little-endian, passed through verbatim. */
  setup: Uint8Array;
}

export interface RetSubmit {
  status: number;
  actualLength: number;
  startFrame: number;
  numberOfPackets: number;
  errorCount: number;
}

/** A decoded URB-phase header, tagged by command. */
export type UsbipReply =
  | { kind: 'submit'; header: UsbipHeaderBasic; body: RetSubmit }
  | { kind: 'unlink'; header: UsbipHeaderBasic; status: number };
