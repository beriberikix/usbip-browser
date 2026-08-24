/**
 * End-to-end: UsbipClient against the mock server, over real wire bytes.
 *
 * Nothing is stubbed between them -- every byte crosses the same codec the
 * network path uses, so these tests exercise the parser, not a fake.
 */
import { describe, expect, it } from 'vitest';
import { UsbipClient } from '../src/client.js';
import { CdcAcmDevice } from '../src/cdc-acm/index.js';
import { UsbipProtocolError, UsbipTransferError } from '../src/errors.js';
import { MOCK_DEVICE, MockTransport } from '../src/mock/index.js';

async function connected() {
  const client = new UsbipClient(new MockTransport());
  await client.connect();
  return client;
}

/** Read from a stream until `predicate` is satisfied or we run out of patience. */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean,
  limit = 200,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  for (let i = 0; i < limit; i++) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (predicate(text)) return text;
  }
  return text;
}

describe('op phase', () => {
  it('lists the emulated device with its interfaces', async () => {
    const client = await connected();
    const devices = await client.listDevices();

    expect(devices).toHaveLength(1);
    const device = devices[0]!;
    expect(device.busid).toBe('1-1');
    expect(device.vendorId).toBe(MOCK_DEVICE.vendorId);
    expect(device.productId).toBe(MOCK_DEVICE.productId);
    expect(device.speed).toBe('full');
    expect(device.interfaces).toHaveLength(2);
    expect(device.interfaces[0]).toEqual({
      interfaceClass: 0x02,
      interfaceSubClass: 0x02,
      interfaceProtocol: 0x01,
    });
  });

  it('imports a device by busid', async () => {
    const client = await connected();
    const device = await client.importDevice('1-1');
    expect(device.busid).toBe('1-1');
    expect(device.vendorId).toBe(MOCK_DEVICE.vendorId);
  });

  it('reports a non-zero status for an unknown busid', async () => {
    const client = await connected();
    await expect(client.importDevice('9-9')).rejects.toThrow(UsbipProtocolError);
  });

  it('refuses listDevices once the connection is in the URB phase', async () => {
    const client = await connected();
    await client.importDevice('1-1');
    await expect(client.listDevices()).rejects.toThrow(/requires state 'op'/);
  });
});

describe('URB phase', () => {
  it('completes a control transfer (SET_CONFIGURATION)', async () => {
    const client = await connected();
    const device = await client.importDevice('1-1');

    await device.selectConfiguration(1);
    expect(device.configurationValue).toBe(1);
  });

  it('returns the requested length from a control IN transfer', async () => {
    const client = await connected();
    const device = await client.importDevice('1-1');

    const result = await device.controlTransferIn(
      { requestType: 'standard', recipient: 'device', request: 0x06, value: 0x0100, index: 0 },
      18,
    );
    expect(result.data.byteLength).toBe(18);
  });

  it('reports a stall as UsbipTransferError with status -32', async () => {
    const client = await connected();
    const device = await client.importDevice('1-1');

    // Endpoint 7 is not implemented by the mock, which stalls it.
    const error = await device.transferIn(7, 8).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UsbipTransferError);
    expect((error as UsbipTransferError).status).toBe(-32);
    expect((error as UsbipTransferError).stalled).toBe(true);
  });

  it('round-trips bulk data through the emulated shell', async () => {
    const client = await connected();
    const device = await client.importDevice('1-1');
    await device.selectConfiguration(1);

    // The device greets us on attach.
    const banner = await device.transferIn(2, 64);
    expect(new TextDecoder().decode(new Uint8Array(banner.data.buffer)).length).toBeGreaterThan(0);

    await device.transferOut(1, new TextEncoder().encode('id\r'));
    const decoder = new TextDecoder();
    let text = '';
    for (let i = 0; i < 20 && !text.includes('busid'); i++) {
      const chunk = await device.transferIn(2, 64);
      text += decoder.decode(
        new Uint8Array(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength),
        { stream: true },
      );
    }
    expect(text).toContain('busid 1-1');
    expect(text).toContain('2e8a:000a');
  });

  it('rejects an in-flight transfer when its AbortSignal fires', async () => {
    const client = await connected();
    const device = await client.importDevice('1-1');
    await device.selectConfiguration(1);
    await device.transferIn(2, 128); // drain the banner

    const controller = new AbortController();
    const pending = device.transferIn(2, 64, controller.signal); // nothing to read yet
    controller.abort();

    await expect(pending).rejects.toThrow(/aborted/i);
  });

  it('rejects pending transfers when the connection closes', async () => {
    const client = await connected();
    const device = await client.importDevice('1-1');
    await device.selectConfiguration(1);
    await device.transferIn(2, 128);

    const pending = device.transferIn(2, 64);
    await client.close();
    await expect(pending).rejects.toThrow();
  });
});

describe('unconfigured device (as usbipd reports one it has just bound)', () => {
  // Real usbipd reports bConfigurationValue = 0 and bNumInterfaces = 0 for a
  // freshly bound device, because `usbip bind` leaves it unconfigured. Zero
  // is not a selectable configuration -- SET_CONFIGURATION(0) *unconfigures*
  // a device -- so it must not be passed through as a default.
  const unconfigured = {
    ...MOCK_DEVICE,
    configurationValue: 0,
    numInterfaces: 0,
    interfaces: [],
  };

  async function connectedTo(device: typeof unconfigured) {
    const client = new UsbipClient(new MockTransport({ device }));
    await client.connect();
    return client;
  }

  it('reports configurationValue 0 verbatim', async () => {
    const client = await connectedTo(unconfigured);
    const devices = await client.listDevices();
    expect(devices[0]!.configurationValue).toBe(0);
    expect(devices[0]!.interfaces).toEqual([]);
  });

  it('selects configuration 1 rather than deconfiguring the device', async () => {
    const client = await connectedTo(unconfigured);
    const device = await client.importDevice('1-1');
    const port = await CdcAcmDevice.open(device);

    expect(device.configurationValue).toBe(1);

    await port.close();
  });

  it('still honours an explicit configurationValue', async () => {
    const client = await connectedTo(unconfigured);
    const device = await client.importDevice('1-1');
    const port = await CdcAcmDevice.open(device, { configurationValue: 2 });

    expect(device.configurationValue).toBe(2);

    await port.close();
  });
});

describe('CDC-ACM over the mock', () => {
  it('configures the port and streams the banner', async () => {
    const client = await connected();
    const device = await client.importDevice('1-1');
    const port = await CdcAcmDevice.open(device, { baudRate: 115200 });

    const reader = port.readable.getReader();
    const text = await readUntil(reader, (t) => t.includes('$'));
    expect(text).toContain('usbip-browser mock device');
    expect(text).toContain('$');

    reader.releaseLock();
    await port.close();
  });

  it('echoes typed input and runs a command', async () => {
    const client = await connected();
    const device = await client.importDevice('1-1');
    const port = await CdcAcmDevice.open(device);

    const reader = port.readable.getReader();
    await readUntil(reader, (t) => t.includes('$'));

    const writer = port.writable.getWriter();
    await writer.write(new TextEncoder().encode('uname\r'));

    const response = await readUntil(reader, (t) => t.includes('mock'));
    expect(response).toContain('usbip-browser mock 0.1.0');

    writer.releaseLock();
    reader.releaseLock();
    await port.close();
  });

  it('reports unknown commands', async () => {
    const client = await connected();
    const device = await client.importDevice('1-1');
    const port = await CdcAcmDevice.open(device);

    const reader = port.readable.getReader();
    await readUntil(reader, (t) => t.includes('$'));

    const writer = port.writable.getWriter();
    await writer.write(new TextEncoder().encode('bogus\r'));

    const response = await readUntil(reader, (t) => t.includes('not found'));
    expect(response).toContain('bogus: command not found');

    writer.releaseLock();
    reader.releaseLock();
    await port.close();
  });

  it('handles backspace editing', async () => {
    const client = await connected();
    const device = await client.importDevice('1-1');
    const port = await CdcAcmDevice.open(device);

    const reader = port.readable.getReader();
    await readUntil(reader, (t) => t.includes('$'));

    const writer = port.writable.getWriter();
    // Type "unamX", erase the X, then complete the command.
    await writer.write(new TextEncoder().encode('unamX\x7fe\r'));

    const response = await readUntil(reader, (t) => t.includes('mock'));
    expect(response).toContain('usbip-browser mock 0.1.0');

    writer.releaseLock();
    reader.releaseLock();
    await port.close();
  });
});
