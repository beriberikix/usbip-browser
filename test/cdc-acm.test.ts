import { describe, expect, it } from 'vitest';
import { CdcAcmDevice, encodeLineCoding, findCdcAcmInterfaces } from '../src/cdc-acm/index.js';
import { UsbipTransferError } from '../src/errors.js';
import type { UsbipDevice } from '../src/device.js';

/**
 * A stand-in for UsbipDevice that replays a scripted sequence of bulk IN
 * results, so stream behaviour can be tested without a transport.
 */
function stubDevice(inResults: Array<Uint8Array | Error>) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let index = 0;

  const device = {
    info: { configurationValue: 0 },
    configurationValue: null as number | null,
    async selectConfiguration(value: number) {
      calls.push({ method: 'selectConfiguration', args: [value] });
      this.configurationValue = value;
    },
    async claimInterface(n: number) {
      calls.push({ method: 'claimInterface', args: [n] });
    },
    async controlTransferOut(setup: unknown, data?: Uint8Array) {
      calls.push({ method: 'controlTransferOut', args: [setup, data] });
      return { bytesWritten: data?.length ?? 0, status: 'ok' as const };
    },
    async transferOut(ep: number, data: Uint8Array) {
      calls.push({ method: 'transferOut', args: [ep, data] });
      return { bytesWritten: data.length, status: 'ok' as const };
    },
    async transferIn(_ep: number, _length: number) {
      const next = inResults[index++];
      if (next === undefined) {
        // Nothing scripted left: block forever, as an idle endpoint does.
        return new Promise<never>(() => {});
      }
      if (next instanceof Error) throw next;
      return {
        data: new DataView(next.buffer, next.byteOffset, next.byteLength),
        status: 'ok' as const,
      };
    },
    async clearHalt(direction: string, ep: number) {
      calls.push({ method: 'clearHalt', args: [direction, ep] });
    },
  };

  return { device: device as unknown as UsbipDevice, calls };
}

const bytes = (s: string) => new TextEncoder().encode(s);

describe('encodeLineCoding', () => {
  it('encodes dwDTERate little-endian with the standard 8N1 codes', () => {
    const coding = encodeLineCoding(115200, 1, 'none', 8);
    expect(coding.length).toBe(7);
    // 115200 == 0x0001C200
    expect([...coding.subarray(0, 4)]).toEqual([0x00, 0xc2, 0x01, 0x00]);
    expect(coding[4]).toBe(0); // 1 stop bit
    expect(coding[5]).toBe(0); // no parity
    expect(coding[6]).toBe(8); // 8 data bits
  });

  it('encodes the non-default framing options', () => {
    const coding = encodeLineCoding(9600, 2, 'even', 7);
    expect(new DataView(coding.buffer).getUint32(0, true)).toBe(9600);
    expect(coding[4]).toBe(2); // 2 stop bits
    expect(coding[5]).toBe(2); // even parity
    expect(coding[6]).toBe(7);
  });
});

describe('configuration selection', () => {
  it('selects configuration 1 when the device reports none', async () => {
    // usbipd reports bConfigurationValue = 0 for a freshly bound device.
    const { device, calls } = stubDevice([]);
    await CdcAcmDevice.open(device);
    expect(calls[0]).toEqual({ method: 'selectConfiguration', args: [1] });
  });

  it('asserts DTR and RTS during open', async () => {
    const { device, calls } = stubDevice([]);
    await CdcAcmDevice.open(device);
    const mhs = calls.filter((c) => c.method === 'controlTransferOut').at(-1);
    expect((mhs?.args[0] as { request: number }).request).toBe(0x22); // SET_CONTROL_LINE_STATE
    expect((mhs?.args[0] as { value: number }).value).toBe(0x03); // DTR | RTS
  });
});

describe('bulk IN stream', () => {
  it('treats a zero-length read as idle, not end of stream', async () => {
    // Real hardware emits zero-length bulk IN completions routinely -- an
    // ESP32-C3 boot log arrives as 32 packets interleaved with 9 of them.
    // Treating one as EOF truncates the stream.
    const { device } = stubDevice([
      bytes('ESP-ROM:'),
      new Uint8Array(0),
      bytes('esp32c3'),
      new Uint8Array(0),
      bytes('-api1'),
    ]);
    const port = await CdcAcmDevice.open(device);
    const reader = port.readable.getReader();

    let text = '';
    const decoder = new TextDecoder();
    for (let i = 0; i < 3; i++) {
      const { value } = await reader.read();
      text += decoder.decode(value, { stream: true });
    }

    expect(text).toBe('ESP-ROM:esp32c3-api1');
    reader.releaseLock();
  });

  it('clears a stalled endpoint and keeps the stream alive', async () => {
    const { device, calls } = stubDevice([
      bytes('before'),
      new UsbipTransferError('stalled', -32),
      bytes('after'),
    ]);
    const port = await CdcAcmDevice.open(device);
    const reader = port.readable.getReader();

    const decoder = new TextDecoder();
    const first = decoder.decode((await reader.read()).value, { stream: true });
    const second = decoder.decode((await reader.read()).value, { stream: true });

    expect(first).toBe('before');
    expect(second).toBe('after');
    expect(calls.some((c) => c.method === 'clearHalt')).toBe(true);
    reader.releaseLock();
  });

  it('propagates a non-stall transfer error', async () => {
    const { device } = stubDevice([new UsbipTransferError('broken pipe', -71)]);
    const port = await CdcAcmDevice.open(device);
    const reader = port.readable.getReader();
    await expect(reader.read()).rejects.toThrow('broken pipe');
  });
});

describe('findCdcAcmInterfaces', () => {
  it('locates the control and data interfaces', () => {
    expect(
      findCdcAcmInterfaces([
        { interfaceClass: 0x02, interfaceSubClass: 0x02 },
        { interfaceClass: 0x0a, interfaceSubClass: 0x00 },
      ]),
    ).toEqual({ controlInterface: 0, dataInterface: 1 });
  });

  it('returns null for a vendor-class device such as a CP2102N', () => {
    expect(findCdcAcmInterfaces([{ interfaceClass: 0xff, interfaceSubClass: 0x00 }])).toBeNull();
  });
});
