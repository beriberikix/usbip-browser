/**
 * RelaynetTransport end to end, against an in-process relay.
 *
 * UsbipClient -> RelaynetTransport -> lwIP -> relaynet's helper -> FakeRelay
 *   -> lwIP (the "bridge" at 10.0.2.15) -> MockTransport as usbipd.
 *
 * Only the relay is simulated (test/support/fake-relay.ts); the helper, both
 * TCP/IP stacks and the USB/IP codec are the real ones.
 */
import { describe, expect, it } from 'vitest';
import { UsbipClient } from '../src/client.js';
import { CdcAcmDevice } from '../src/cdc-acm/index.js';
import { MOCK_DEVICE } from '../src/mock/index.js';
import { RelaynetError, RelaynetTransport } from '../src/transport/relaynet.js';
import { BRIDGE_ADDRESS, FakeRelay } from './support/fake-relay.js';

const TARGET = `${BRIDGE_ADDRESS}:3240`;

async function transportFor(relay: FakeRelay, options: Record<string, unknown> = {}) {
  return new RelaynetTransport(TARGET, {
    token: 'rr_test',
    url: 'wss://relay.example.test/',
    WebSocket: relay.WebSocket,
    checkToken: false,
    timeoutMs: 8000,
    ...options,
  });
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, predicate: (t: string) => boolean) {
  const decoder = new TextDecoder();
  let text = '';
  for (let i = 0; i < 200 && !predicate(text); i++) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

describe('RelaynetTransport', () => {
  it('rejects a target that is not an IPv4 address and port', () => {
    expect(() => new RelaynetTransport('usbipd.local:3240')).toThrow(RelaynetError);
    expect(() => new RelaynetTransport('10.0.2.15')).toThrow(RelaynetError);
    expect(() => new RelaynetTransport('10.0.2.15:70000')).toThrow(/invalid port/);
  });

  it('leases an address, sends the token as a subprotocol and lists devices', async () => {
    const relay = await FakeRelay.create();
    const transport = await transportFor(relay);
    const client = new UsbipClient(transport);
    await client.connect();

    expect(transport.address).toBe('10.0.2.16');
    expect(relay.handshakes[0]).toEqual(['relay.v1', 'relay.token.rr_test']);

    const devices = await client.listDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0]!.vendorId).toBe(MOCK_DEVICE.vendorId);
    await client.close();
  });

  it('omits the token subprotocol when there is no token', async () => {
    const relay = await FakeRelay.create();
    const transport = await transportFor(relay, { token: undefined });
    await transport.open();
    expect(relay.handshakes[0]).toEqual(['relay.v1']);
    await transport.close();
  });

  it('carries a CDC-ACM session: banner, command and reply', async () => {
    const relay = await FakeRelay.create();
    const client = new UsbipClient(await transportFor(relay));
    await client.connect();
    const device = await client.importDevice('1-1');
    const port = await CdcAcmDevice.open(device, { baudRate: 115200 });
    const reader = port.readable.getReader();
    expect(await readUntil(reader, (t) => t.includes('$'))).toContain('usbip-browser mock device');

    const writer = port.writable.getWriter();
    await writer.write(new TextEncoder().encode('help\r'));
    expect(await readUntil(reader, (t) => t.includes('$'))).toMatch(/help/i);

    reader.releaseLock();
    writer.releaseLock();
    await port.close();
    await client.close();
  });

  it('survives a dropped session when DHCP gives the same address back', async () => {
    const relay = await FakeRelay.create();
    const statuses: string[] = [];
    const client = new UsbipClient(await transportFor(relay, { onStatus: (s: string) => statuses.push(s) }));
    await client.connect();
    const device = await client.importDevice('1-1');
    const port = await CdcAcmDevice.open(device, { baudRate: 115200 });
    const reader = port.readable.getReader();
    await readUntil(reader, (t) => t.includes('$'));

    relay.drop();
    await expect.poll(() => relay.sessions, { timeout: 5000 }).toBe(2);
    await expect.poll(() => statuses.some((s) => s.includes('restored')), { timeout: 5000 }).toBe(true);

    const writer = port.writable.getWriter();
    await writer.write(new TextEncoder().encode('help\r'));
    expect(await readUntil(reader, (t) => t.includes('$'))).toMatch(/help/i);

    reader.releaseLock();
    writer.releaseLock();
    await port.close();
    await client.close();
  }, 20_000);

  it('closes with an error when the address does not come back', async () => {
    const relay = await FakeRelay.create();
    const transport = await transportFor(relay);
    const closed = new Promise<Error | undefined>((resolve) => transport.onClose(resolve));
    await transport.open();

    relay.forgetLeases();
    relay.drop();
    const cause = await closed;
    expect(cause).toBeInstanceOf(RelaynetError);
    expect(cause!.message).toMatch(/came back with 10\.0\.2\.17 instead of 10\.0\.2\.16/);
  }, 15_000);

  it('closes with the relay reason on a final close', async () => {
    const relay = await FakeRelay.create();
    const transport = await transportFor(relay);
    const closed = new Promise<Error | undefined>((resolve) => transport.onClose(resolve));
    await transport.open();

    relay.end('token revoked');
    const cause = (await closed) as RelaynetError;
    expect(cause).toBeInstanceOf(RelaynetError);
    expect(cause.code).toBe(1008);
    expect(cause.message).toMatch(/token revoked/);
  });

  it('times out open() when the relay keeps refusing', async () => {
    const relay = await FakeRelay.create();
    relay.refuse = true;
    const transport = await transportFor(relay, { timeoutMs: 300 });
    await expect(transport.open()).rejects.toThrow(/within 300 ms/);
  });

  it('close() is idempotent and reports a clean close', async () => {
    const relay = await FakeRelay.create();
    const transport = await transportFor(relay);
    const causes: Array<Error | undefined> = [];
    transport.onClose((cause) => causes.push(cause));
    await transport.open();
    await transport.close();
    await transport.close();
    expect(causes).toEqual([undefined]);
    await expect(transport.send(new Uint8Array([1]))).rejects.toThrow(/closed/);
  });
});
