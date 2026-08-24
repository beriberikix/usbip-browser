/**
 * USB/IP wire protocol constants.
 *
 * Reference: linux/tools/usb/usbip/src/usbip_network.h and
 * linux/drivers/usb/usbip/usbip_common.h
 *
 * Every field in these structures is big-endian, with one exception: the
 * 8-byte `setup` packet inside CMD_SUBMIT is a raw USB setup packet and
 * stays little-endian. See codec.ts.
 */

/** Protocol version 1.1.1, sent in the op-phase header. */
export const USBIP_VERSION = 0x0111;

/** Op-phase (handshake) message codes. */
export const OP_REQ_DEVLIST = 0x8005;
export const OP_REP_DEVLIST = 0x0005;
export const OP_REQ_IMPORT = 0x8003;
export const OP_REP_IMPORT = 0x0003;

/** URB-phase command codes. */
export const USBIP_CMD_SUBMIT = 0x00000001;
export const USBIP_CMD_UNLINK = 0x00000002;
export const USBIP_RET_SUBMIT = 0x00000003;
export const USBIP_RET_UNLINK = 0x00000004;

/** URB direction. Note this is the opposite sense of the USB endpoint bit. */
export const USBIP_DIR_OUT = 0;
export const USBIP_DIR_IN = 1;

/** Fixed struct sizes. Asserted in tests: these must never drift. */
export const SIZEOF_OP_HEADER = 8;
export const SIZEOF_OP_REQ_IMPORT = 40;
export const SIZEOF_USB_DEVICE = 312;
export const SIZEOF_USB_INTERFACE = 4;
export const SIZEOF_URB_HEADER = 48;

/** Field widths inside usbip_usb_device. */
export const USBIP_PATH_MAX = 256;
export const USBIP_BUSID_SIZE = 32;

/** URB transfer flags (subset; mirrors linux/include/linux/usb.h). */
export const URB_SHORT_NOT_OK = 0x00000001;
export const URB_ISO_ASAP = 0x00000002;
export const URB_ZERO_PACKET = 0x00000040;

/** Device speeds as reported in usbip_usb_device.speed. */
export const USB_SPEED = {
  unknown: 0,
  low: 1,
  full: 2,
  high: 3,
  wireless: 4,
  super: 5,
  superPlus: 6,
} as const;

export type UsbSpeed = keyof typeof USB_SPEED;

const SPEED_NAMES = Object.entries(USB_SPEED) as ReadonlyArray<[UsbSpeed, number]>;

export function speedFromCode(code: number): UsbSpeed {
  return SPEED_NAMES.find(([, v]) => v === code)?.[0] ?? 'unknown';
}

/**
 * Standard USB request codes used by the device-configuration path. USB/IP
 * hands us a device whose kernel driver has already been detached, so we are
 * responsible for issuing these ourselves over endpoint 0.
 */
export const USB_REQUEST = {
  GET_DESCRIPTOR: 0x06,
  SET_CONFIGURATION: 0x09,
  SET_INTERFACE: 0x0b,
} as const;

export const USB_DESCRIPTOR_TYPE = {
  DEVICE: 0x01,
  CONFIGURATION: 0x02,
  STRING: 0x03,
  INTERFACE: 0x04,
  ENDPOINT: 0x05,
} as const;
