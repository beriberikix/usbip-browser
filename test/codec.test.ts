import { describe, expect, it } from 'vitest';
import {
  decodeCmdSubmit,
  decodeOpHeader,
  decodeUrbHeader,
  decodeUsbDevice,
  decodeUsbInterface,
  encodeCmdSubmit,
  encodeCmdUnlink,
  encodeOpReqDevlist,
  encodeOpReqImport,
  encodeRetSubmit,
  encodeSetupPacket,
  encodeUsbDevice,
  encodeUsbInterface,
  makeDevid,
} from '../src/protocol/codec.js';
import {
  OP_REQ_DEVLIST,
  OP_REQ_IMPORT,
  SIZEOF_OP_HEADER,
  SIZEOF_OP_REQ_IMPORT,
  SIZEOF_URB_HEADER,
  SIZEOF_USB_DEVICE,
  SIZEOF_USB_INTERFACE,
  USBIP_CMD_SUBMIT,
  USBIP_VERSION,
} from '../src/protocol/constants.js';
import type { UsbipDeviceInfo } from '../src/protocol/types.js';

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

describe('struct sizes are frozen', () => {
  // These come from linux/tools/usb/usbip/src/usbip_network.h. If any drifts,
  // every offset below it silently corrupts -- so assert them directly.
  it('matches the kernel layout', () => {
    expect(SIZEOF_OP_HEADER).toBe(8);
    expect(SIZEOF_OP_REQ_IMPORT).toBe(40);
    expect(SIZEOF_USB_DEVICE).toBe(312);
    expect(SIZEOF_USB_INTERFACE).toBe(4);
    expect(SIZEOF_URB_HEADER).toBe(48);
  });

  it('emits structures at exactly those sizes', () => {
    expect(encodeOpReqDevlist().length).toBe(SIZEOF_OP_HEADER);
    expect(encodeOpReqImport('1-1').length).toBe(SIZEOF_OP_REQ_IMPORT);
    expect(encodeUsbInterface({ interfaceClass: 2, interfaceSubClass: 2, interfaceProtocol: 1 }).length).toBe(4);
  });
});

describe('op phase', () => {
  it('encodes OP_REQ_DEVLIST big-endian', () => {
    // version 0x0111, code 0x8005, status 0
    expect(hex(encodeOpReqDevlist())).toBe('011180050000' + '0000');
  });

  it('encodes OP_REQ_IMPORT with a NUL-padded busid', () => {
    const out = encodeOpReqImport('1-1.4');
    expect(hex(out.subarray(0, 8))).toBe('0111800300000000');
    expect(new TextDecoder().decode(out.subarray(8, 13))).toBe('1-1.4');
    // Everything after the busid must be zero padding.
    expect([...out.subarray(13)].every((b) => b === 0)).toBe(true);
  });

  it('rejects a busid that would not fit with its NUL terminator', () => {
    expect(() => encodeOpReqImport('x'.repeat(32))).toThrow(/exceeds/);
  });

  it('round-trips the op header', () => {
    const header = decodeOpHeader(encodeOpReqDevlist());
    expect(header).toEqual({ version: USBIP_VERSION, code: OP_REQ_DEVLIST, status: 0 });
    expect(decodeOpHeader(encodeOpReqImport('1-1').subarray(0, 8)).code).toBe(OP_REQ_IMPORT);
  });

  it('rejects a short op header', () => {
    expect(() => decodeOpHeader(new Uint8Array(4))).toThrow(/8 bytes/);
  });
});

describe('usbip_usb_device', () => {
  const device: UsbipDeviceInfo = {
    path: '/sys/devices/pci0000:00/0000:00:14.0/usb1/1-1',
    busid: '1-1',
    busnum: 1,
    devnum: 4,
    speed: 'high',
    vendorId: 0x0403,
    productId: 0x6001,
    bcdDevice: 0x0600,
    deviceClass: 0x00,
    deviceSubClass: 0x00,
    deviceProtocol: 0x00,
    configurationValue: 1,
    numConfigurations: 1,
    numInterfaces: 1,
    interfaces: [],
  };

  it('round-trips every field', () => {
    expect(decodeUsbDevice(encodeUsbDevice(device))).toEqual(device);
  });

  it('places busnum immediately after the two string fields', () => {
    const encoded = encodeUsbDevice(device);
    const view = new DataView(encoded.buffer);
    expect(view.getUint32(256 + 32, false)).toBe(1); // busnum, big-endian
    expect(view.getUint32(256 + 32 + 4, false)).toBe(4); // devnum
  });

  it('decodes vendor and product as big-endian u16', () => {
    const encoded = encodeUsbDevice(device);
    const view = new DataView(encoded.buffer);
    expect(view.getUint16(256 + 32 + 12, false)).toBe(0x0403);
    expect(view.getUint16(256 + 32 + 14, false)).toBe(0x6001);
  });

  it('maps unknown speed codes to "unknown"', () => {
    const encoded = encodeUsbDevice(device);
    new DataView(encoded.buffer).setUint32(256 + 32 + 8, 99, false);
    expect(decodeUsbDevice(encoded).speed).toBe('unknown');
  });

  it('round-trips an interface and ignores its padding byte', () => {
    const iface = { interfaceClass: 0x02, interfaceSubClass: 0x02, interfaceProtocol: 0x01 };
    const encoded = encodeUsbInterface(iface);
    expect(encoded[3]).toBe(0);
    expect(decodeUsbInterface(encoded)).toEqual(iface);
  });
});

describe('setup packet endianness', () => {
  // The single most bug-prone corner of this protocol: USB/IP headers are
  // big-endian, but the embedded setup packet is USB's own little-endian.
  it('writes wValue/wIndex/wLength little-endian', () => {
    const setup = encodeSetupPacket(0x80, 0x06, 0x0100, 0x0000, 18);
    expect(hex(setup)).toBe('8006' + '0001' + '0000' + '1200');
  });

  it('keeps the setup packet little-endian inside a big-endian header', () => {
    const setup = encodeSetupPacket(0x21, 0x20, 0x0000, 0x0001, 7);
    const frame = encodeCmdSubmit(
      { command: 0, seqnum: 0x11223344, devid: makeDevid(1, 4), direction: 0, ep: 0 },
      {
        transferFlags: 0,
        transferBufferLength: 7,
        startFrame: 0,
        numberOfPackets: -1,
        interval: 0,
        setup,
      },
    );
    const view = new DataView(frame.buffer);
    // Header fields: big-endian.
    expect(view.getUint32(0, false)).toBe(USBIP_CMD_SUBMIT);
    expect(view.getUint32(4, false)).toBe(0x11223344);
    expect(view.getInt32(32, false)).toBe(-1); // number_of_packets
    // Setup packet: little-endian, verbatim at offset 40.
    expect(hex(frame.subarray(40, 48))).toBe('2120' + '0000' + '0100' + '0700');
  });
});

describe('URB phase', () => {
  const header = { command: 0, seqnum: 7, devid: makeDevid(1, 4), direction: 1, ep: 2 };

  it('packs devid as (busnum << 16) | devnum', () => {
    expect(makeDevid(1, 4)).toBe(0x00010004);
    expect(makeDevid(0xffff, 0xffff)).toBe(0xffffffff);
  });

  it('emits a 48-byte header plus payload for OUT transfers', () => {
    const payload = new Uint8Array([1, 2, 3]);
    const frame = encodeCmdSubmit(
      header,
      {
        transferFlags: 0,
        transferBufferLength: payload.length,
        startFrame: 0,
        numberOfPackets: -1,
        interval: 0,
        setup: new Uint8Array(8),
      },
      payload,
    );
    expect(frame.length).toBe(SIZEOF_URB_HEADER + 3);
    expect(frame.subarray(48)).toEqual(payload);
  });

  it('round-trips CMD_SUBMIT', () => {
    const body = {
      transferFlags: 0x2,
      transferBufferLength: 64,
      startFrame: 0,
      numberOfPackets: -1,
      interval: 0,
      setup: encodeSetupPacket(0x80, 0x06, 0x0100, 0, 18),
    };
    const decoded = decodeCmdSubmit(encodeCmdSubmit(header, body));
    expect(decoded.header.seqnum).toBe(7);
    expect(decoded.header.ep).toBe(2);
    expect(decoded.body).toEqual(body);
  });

  it('rejects a setup packet that is not 8 bytes', () => {
    expect(() =>
      encodeCmdSubmit(header, {
        transferFlags: 0,
        transferBufferLength: 0,
        startFrame: 0,
        numberOfPackets: -1,
        interval: 0,
        setup: new Uint8Array(4),
      }),
    ).toThrow(/8 bytes/);
  });

  it('decodes RET_SUBMIT including a negative status', () => {
    const frame = encodeRetSubmit(header, { status: -32, actualLength: 0 });
    const reply = decodeUrbHeader(frame);
    expect(reply.kind).toBe('submit');
    if (reply.kind !== 'submit') throw new Error('unreachable');
    expect(reply.body.status).toBe(-32); // -EPIPE, i.e. endpoint stalled
    expect(reply.header.seqnum).toBe(7);
  });

  it('pads CMD_UNLINK to 48 bytes and carries the victim seqnum', () => {
    const frame = encodeCmdUnlink({ ...header, seqnum: 9 }, 7);
    expect(frame.length).toBe(SIZEOF_URB_HEADER);
    const view = new DataView(frame.buffer);
    expect(view.getUint32(4, false)).toBe(9); // this request's seqnum
    expect(view.getUint32(20, false)).toBe(7); // the URB being unlinked
  });

  it('throws on an unrecognised command rather than guessing', () => {
    const frame = new Uint8Array(SIZEOF_URB_HEADER);
    new DataView(frame.buffer).setUint32(0, 0xdeadbeef, false);
    expect(() => decodeUrbHeader(frame)).toThrow(/unexpected USB\/IP command/);
  });

  it('rejects a truncated URB header', () => {
    expect(() => decodeUrbHeader(new Uint8Array(47))).toThrow(/48 bytes/);
  });
});
