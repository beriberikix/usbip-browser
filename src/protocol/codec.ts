/**
 * Encoders and decoders for the USB/IP wire format.
 *
 * Endianness rule, and the one thing most worth remembering here: every
 * USB/IP field is BIG-endian, except the 8-byte `setup` packet inside
 * CMD_SUBMIT, which is a raw USB setup packet and therefore LITTLE-endian.
 * `encodeSetupPacket` is the only place that writes little-endian.
 */
import {
  OP_REQ_DEVLIST,
  OP_REQ_IMPORT,
  SIZEOF_OP_HEADER,
  SIZEOF_OP_REQ_IMPORT,
  SIZEOF_URB_HEADER,
  SIZEOF_USB_DEVICE,
  SIZEOF_USB_INTERFACE,
  USBIP_BUSID_SIZE,
  USBIP_CMD_SUBMIT,
  USBIP_CMD_UNLINK,
  USBIP_PATH_MAX,
  USBIP_RET_SUBMIT,
  USBIP_RET_UNLINK,
  USBIP_VERSION,
  USB_SPEED,
  speedFromCode,
} from './constants.js';
import type {
  CmdSubmit,
  UsbipDeviceInfo,
  UsbipHeaderBasic,
  UsbipInterface,
  UsbipReply,
} from './types.js';

const BE = false; // DataView's `littleEndian` argument. USB/IP is big-endian.

const utf8Decoder = new TextDecoder();
const utf8Encoder = new TextEncoder();

/** Read a NUL-padded fixed-width ASCII field. */
function readFixedString(view: DataView, offset: number, size: number): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, size);
  const end = bytes.indexOf(0);
  return utf8Decoder.decode(end === -1 ? bytes : bytes.subarray(0, end));
}

/** Write a NUL-padded fixed-width ASCII field, truncating if oversized. */
function writeFixedString(target: Uint8Array, offset: number, size: number, value: string): void {
  const encoded = utf8Encoder.encode(value);
  if (encoded.length >= size) {
    throw new RangeError(`value ${JSON.stringify(value)} exceeds ${size - 1} bytes`);
  }
  target.set(encoded, offset);
}

// ---------------------------------------------------------------------------
// Op phase (handshake)
// ---------------------------------------------------------------------------

export interface OpHeader {
  version: number;
  code: number;
  status: number;
}

export function encodeOpReqDevlist(): Uint8Array {
  const out = new Uint8Array(SIZEOF_OP_HEADER);
  const view = new DataView(out.buffer);
  view.setUint16(0, USBIP_VERSION, BE);
  view.setUint16(2, OP_REQ_DEVLIST, BE);
  view.setUint32(4, 0, BE);
  return out;
}

export function encodeOpReqImport(busid: string): Uint8Array {
  const out = new Uint8Array(SIZEOF_OP_REQ_IMPORT);
  const view = new DataView(out.buffer);
  view.setUint16(0, USBIP_VERSION, BE);
  view.setUint16(2, OP_REQ_IMPORT, BE);
  view.setUint32(4, 0, BE);
  writeFixedString(out, SIZEOF_OP_HEADER, USBIP_BUSID_SIZE, busid);
  return out;
}

export function decodeOpHeader(bytes: Uint8Array): OpHeader {
  if (bytes.length !== SIZEOF_OP_HEADER) {
    throw new RangeError(`op header must be ${SIZEOF_OP_HEADER} bytes, got ${bytes.length}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    version: view.getUint16(0, BE),
    code: view.getUint16(2, BE),
    status: view.getUint32(4, BE),
  };
}

/** Decode one `usbip_usb_device`. Interfaces are appended separately. */
export function decodeUsbDevice(bytes: Uint8Array): UsbipDeviceInfo {
  if (bytes.length !== SIZEOF_USB_DEVICE) {
    throw new RangeError(`usb device must be ${SIZEOF_USB_DEVICE} bytes, got ${bytes.length}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const path = readFixedString(view, o, USBIP_PATH_MAX);
  o += USBIP_PATH_MAX;
  const busid = readFixedString(view, o, USBIP_BUSID_SIZE);
  o += USBIP_BUSID_SIZE;

  return {
    path,
    busid,
    busnum: view.getUint32(o, BE),
    devnum: view.getUint32(o + 4, BE),
    speed: speedFromCode(view.getUint32(o + 8, BE)),
    vendorId: view.getUint16(o + 12, BE),
    productId: view.getUint16(o + 14, BE),
    bcdDevice: view.getUint16(o + 16, BE),
    deviceClass: view.getUint8(o + 18),
    deviceSubClass: view.getUint8(o + 19),
    deviceProtocol: view.getUint8(o + 20),
    configurationValue: view.getUint8(o + 21),
    numConfigurations: view.getUint8(o + 22),
    numInterfaces: view.getUint8(o + 23),
    interfaces: [],
  };
}

export function encodeUsbDevice(dev: UsbipDeviceInfo): Uint8Array {
  const out = new Uint8Array(SIZEOF_USB_DEVICE);
  const view = new DataView(out.buffer);
  writeFixedString(out, 0, USBIP_PATH_MAX, dev.path);
  writeFixedString(out, USBIP_PATH_MAX, USBIP_BUSID_SIZE, dev.busid);
  const o = USBIP_PATH_MAX + USBIP_BUSID_SIZE;
  view.setUint32(o, dev.busnum, BE);
  view.setUint32(o + 4, dev.devnum, BE);
  view.setUint32(o + 8, USB_SPEED[dev.speed], BE);
  view.setUint16(o + 12, dev.vendorId, BE);
  view.setUint16(o + 14, dev.productId, BE);
  view.setUint16(o + 16, dev.bcdDevice, BE);
  view.setUint8(o + 18, dev.deviceClass);
  view.setUint8(o + 19, dev.deviceSubClass);
  view.setUint8(o + 20, dev.deviceProtocol);
  view.setUint8(o + 21, dev.configurationValue);
  view.setUint8(o + 22, dev.numConfigurations);
  view.setUint8(o + 23, dev.numInterfaces);
  return out;
}

export function decodeUsbInterface(bytes: Uint8Array): UsbipInterface {
  if (bytes.length !== SIZEOF_USB_INTERFACE) {
    throw new RangeError(`usb interface must be ${SIZEOF_USB_INTERFACE} bytes`);
  }
  return {
    interfaceClass: bytes[0]!,
    interfaceSubClass: bytes[1]!,
    interfaceProtocol: bytes[2]!,
    // bytes[3] is padding.
  };
}

export function encodeUsbInterface(iface: UsbipInterface): Uint8Array {
  return new Uint8Array([
    iface.interfaceClass,
    iface.interfaceSubClass,
    iface.interfaceProtocol,
    0,
  ]);
}

// ---------------------------------------------------------------------------
// URB phase
// ---------------------------------------------------------------------------

/** `devid` packs the bus and device numbers into one 32-bit field. */
export function makeDevid(busnum: number, devnum: number): number {
  return ((busnum << 16) | devnum) >>> 0;
}

/**
 * Build the 8-byte USB setup packet. This is the sole little-endian
 * structure in the protocol -- it is USB's own format, tunnelled verbatim.
 */
export function encodeSetupPacket(
  bmRequestType: number,
  bRequest: number,
  wValue: number,
  wIndex: number,
  wLength: number,
): Uint8Array {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setUint8(0, bmRequestType);
  view.setUint8(1, bRequest);
  view.setUint16(2, wValue, true); // little-endian, deliberately
  view.setUint16(4, wIndex, true);
  view.setUint16(6, wLength, true);
  return out;
}

export function encodeCmdSubmit(
  header: UsbipHeaderBasic,
  body: CmdSubmit,
  payload?: Uint8Array,
): Uint8Array {
  const total = SIZEOF_URB_HEADER + (payload?.length ?? 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);

  view.setUint32(0, USBIP_CMD_SUBMIT, BE);
  view.setUint32(4, header.seqnum, BE);
  view.setUint32(8, header.devid, BE);
  view.setUint32(12, header.direction, BE);
  view.setUint32(16, header.ep, BE);

  view.setUint32(20, body.transferFlags, BE);
  view.setInt32(24, body.transferBufferLength, BE);
  view.setInt32(28, body.startFrame, BE);
  view.setInt32(32, body.numberOfPackets, BE);
  view.setInt32(36, body.interval, BE);

  if (body.setup.length !== 8) {
    throw new RangeError(`setup packet must be 8 bytes, got ${body.setup.length}`);
  }
  out.set(body.setup, 40);
  if (payload?.length) out.set(payload, SIZEOF_URB_HEADER);
  return out;
}

export function encodeCmdUnlink(header: UsbipHeaderBasic, victimSeqnum: number): Uint8Array {
  const out = new Uint8Array(SIZEOF_URB_HEADER);
  const view = new DataView(out.buffer);
  view.setUint32(0, USBIP_CMD_UNLINK, BE);
  view.setUint32(4, header.seqnum, BE);
  view.setUint32(8, header.devid, BE);
  view.setUint32(12, header.direction, BE);
  view.setUint32(16, header.ep, BE);
  view.setUint32(20, victimSeqnum, BE);
  // Remaining 24 bytes are padding.
  return out;
}

/** Encode RET_SUBMIT. Used by the mock server; the client only decodes it. */
export function encodeRetSubmit(
  header: UsbipHeaderBasic,
  body: { status: number; actualLength: number; errorCount?: number },
  payload?: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(SIZEOF_URB_HEADER + (payload?.length ?? 0));
  const view = new DataView(out.buffer);
  view.setUint32(0, USBIP_RET_SUBMIT, BE);
  view.setUint32(4, header.seqnum, BE);
  view.setUint32(8, header.devid, BE);
  view.setUint32(12, header.direction, BE);
  view.setUint32(16, header.ep, BE);
  view.setInt32(20, body.status, BE);
  view.setInt32(24, body.actualLength, BE);
  view.setInt32(28, 0, BE); // start_frame
  view.setInt32(32, 0, BE); // number_of_packets
  view.setInt32(36, body.errorCount ?? 0, BE);
  // Bytes 40..47 are padding.
  if (payload?.length) out.set(payload, SIZEOF_URB_HEADER);
  return out;
}

export function encodeRetUnlink(header: UsbipHeaderBasic, status: number): Uint8Array {
  const out = new Uint8Array(SIZEOF_URB_HEADER);
  const view = new DataView(out.buffer);
  view.setUint32(0, USBIP_RET_UNLINK, BE);
  view.setUint32(4, header.seqnum, BE);
  view.setUint32(8, header.devid, BE);
  view.setUint32(12, header.direction, BE);
  view.setUint32(16, header.ep, BE);
  view.setInt32(20, status, BE);
  return out;
}

/**
 * Decode a 48-byte URB-phase reply header.
 *
 * Note what this deliberately does NOT tell you: whether a payload follows.
 * The `direction` field is unreliable in RET_SUBMIT across usbipd
 * implementations (frequently zero regardless of the request), so the caller
 * must decide payload presence from its own pending-request map keyed by
 * seqnum. See UsbipDevice.
 */
export function decodeUrbHeader(bytes: Uint8Array): UsbipReply {
  if (bytes.length !== SIZEOF_URB_HEADER) {
    throw new RangeError(`urb header must be ${SIZEOF_URB_HEADER} bytes, got ${bytes.length}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header: UsbipHeaderBasic = {
    command: view.getUint32(0, BE),
    seqnum: view.getUint32(4, BE),
    devid: view.getUint32(8, BE),
    direction: view.getUint32(12, BE),
    ep: view.getUint32(16, BE),
  };

  switch (header.command) {
    case USBIP_RET_SUBMIT:
      return {
        kind: 'submit',
        header,
        body: {
          status: view.getInt32(20, BE),
          actualLength: view.getInt32(24, BE),
          startFrame: view.getInt32(28, BE),
          numberOfPackets: view.getInt32(32, BE),
          errorCount: view.getInt32(36, BE),
        },
      };
    case USBIP_RET_UNLINK:
      return { kind: 'unlink', header, status: view.getInt32(20, BE) };
    default:
      throw new Error(
        `unexpected USB/IP command 0x${header.command.toString(16).padStart(8, '0')}`,
      );
  }
}

/** Decode a CMD_SUBMIT header. Used by the mock server. */
export function decodeCmdSubmit(bytes: Uint8Array): { header: UsbipHeaderBasic; body: CmdSubmit } {
  if (bytes.length !== SIZEOF_URB_HEADER) {
    throw new RangeError(`urb header must be ${SIZEOF_URB_HEADER} bytes`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    header: {
      command: view.getUint32(0, BE),
      seqnum: view.getUint32(4, BE),
      devid: view.getUint32(8, BE),
      direction: view.getUint32(12, BE),
      ep: view.getUint32(16, BE),
    },
    body: {
      transferFlags: view.getUint32(20, BE),
      transferBufferLength: view.getInt32(24, BE),
      startFrame: view.getInt32(28, BE),
      numberOfPackets: view.getInt32(32, BE),
      interval: view.getInt32(36, BE),
      setup: bytes.slice(40, 48),
    },
  };
}
