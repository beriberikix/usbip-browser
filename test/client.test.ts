/**
 * UsbipClient driven by an exactly-scripted transport.
 *
 * The mock server cannot express the orderings that matter here -- notably a
 * URB completing on the device at the same moment the client gives up on it
 * -- so these tests feed the client raw bytes directly.
 */
import { describe, expect, it } from 'vitest';
import { UsbipClient } from '../src/client.js';
import { encodeRetSubmit, encodeRetUnlink, encodeUsbDevice, makeDevid } from '../src/protocol/codec.js';
import { OP_REP_IMPORT, USBIP_VERSION } from '../src/protocol/constants.js';
import { MOCK_DEVICE } from '../src/mock/index.js';
import type { UsbipTransport } from '../src/transport/types.js';

class ScriptedTransport implements UsbipTransport {
  sent: Uint8Array[] = [];
  #data: ((chunk: Uint8Array) => void) | null = null;
  #close: ((cause?: Error) => void) | null = null;

  async open(): Promise<void> {}
  async send(chunk: Uint8Array): Promise<void> {
    this.sent.push(chunk.slice());
  }
  onData(handler: (chunk: Uint8Array) => void): void {
    this.#data = handler;
  }
  onClose(handler: (cause?: Error) => void): void {
    this.#close = handler;
  }
  async close(): Promise<void> {}

  /** Deliver bytes as if they arrived from the network. */
  feed(...parts: Uint8Array[]): void {
    this.#data?.(concat(parts));
  }
  drop(cause?: Error): void {
    this.#close?.(cause);
  }

  /** Decoded seqnums of the URB-phase frames we sent, in order. */
  submittedSeqnums(): number[] {
    return this.sent
      .filter((f) => f.length >= 48 && new DataView(f.buffer, f.byteOffset).getUint32(0, false) <= 2)
      .map((f) => new DataView(f.buffer, f.byteOffset).getUint32(4, false));
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function opHeader(code: number, status = 0): Uint8Array {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setUint16(0, USBIP_VERSION, false);
  view.setUint16(2, code, false);
  view.setUint32(4, status, false);
  return out;
}

const DEVID = makeDevid(MOCK_DEVICE.busnum, MOCK_DEVICE.devnum);

async function importedDevice() {
  const transport = new ScriptedTransport();
  const client = new UsbipClient(transport);
  await client.connect();
  const importing = client.importDevice('1-1');
  transport.feed(opHeader(OP_REP_IMPORT), encodeUsbDevice(MOCK_DEVICE));
  const device = await importing;
  return { transport, client, device };
}

/** RET_SUBMIT for an IN transfer, header plus payload. */
function retSubmitIn(seqnum: number, payload: Uint8Array, status = 0): Uint8Array {
  return encodeRetSubmit(
    { command: 0, seqnum, devid: DEVID, direction: 1, ep: 2 },
    { status, actualLength: payload.length },
    payload,
  );
}

const bytes = (...v: number[]) => new Uint8Array(v);

describe('abort races a completing URB', () => {
  it('drains the payload of a reply that arrives after abort', async () => {
    // The URB completes on the device just as the client gives up. The server
    // has no idea, so it sends an ordinary RET_SUBMIT with real payload bytes.
    // Those bytes must come off the stream even though nobody wants them --
    // otherwise the next header is parsed from the middle of a payload and
    // the connection is silently corrupted from then on.
    const { transport, device } = await importedDevice();

    const controller = new AbortController();
    const aborted = device.transferIn(2, 64, controller.signal);
    await Promise.resolve();
    controller.abort();
    await expect(aborted).rejects.toThrow(/abort/i);

    const [submitSeqnum] = transport.submittedSeqnums();
    expect(submitSeqnum).toBe(1);

    // The late, data-bearing reply for the abandoned transfer.
    transport.feed(retSubmitIn(submitSeqnum!, bytes(0xaa, 0xbb, 0xcc, 0xdd)));

    // A fresh transfer must decode correctly. If the four payload bytes above
    // were left in the stream, this header would be read from the wrong
    // offset and the connection would be dead.
    const next = device.transferIn(2, 64);
    await Promise.resolve();
    const seqnums = transport.submittedSeqnums();
    const nextSeqnum = seqnums[seqnums.length - 1]!;
    transport.feed(retSubmitIn(nextSeqnum, bytes(0x11, 0x22)));

    const result = await next;
    expect(new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength)).toEqual(
      bytes(0x11, 0x22),
    );
  });

  it('survives several aborted transfers in a row', async () => {
    const { transport, device } = await importedDevice();

    for (let i = 0; i < 3; i++) {
      const controller = new AbortController();
      const aborted = device.transferIn(2, 64, controller.signal);
      await Promise.resolve();
      controller.abort();
      await expect(aborted).rejects.toThrow(/abort/i);

      const seqnums = transport.submittedSeqnums();
      // The submit precedes its unlink, so the submit is second from the end.
      const submitSeqnum = seqnums[seqnums.length - 2]!;
      transport.feed(retSubmitIn(submitSeqnum, bytes(1, 2, 3, 4, 5, 6, 7, 8)));
    }

    const next = device.transferIn(2, 64);
    await Promise.resolve();
    const seqnums = transport.submittedSeqnums();
    transport.feed(retSubmitIn(seqnums[seqnums.length - 1]!, bytes(0x42)));

    const result = await next;
    expect(new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength)).toEqual(
      bytes(0x42),
    );
  });

  it('retires the abandoned entry when RET_UNLINK arrives instead', async () => {
    // The other outcome of the race: the server really did cancel the URB, so
    // no RET_SUBMIT follows. RET_UNLINK echoes the unlink command's seqnum,
    // not the URB's, so the victim has to be looked up.
    const { transport, device, client } = await importedDevice();

    const controller = new AbortController();
    const aborted = device.transferIn(2, 64, controller.signal);
    await Promise.resolve();
    controller.abort();
    await expect(aborted).rejects.toThrow(/abort/i);

    const seqnums = transport.submittedSeqnums();
    const unlinkSeqnum = seqnums[seqnums.length - 1]!;
    expect(unlinkSeqnum).not.toBe(seqnums[0]);

    transport.feed(encodeRetUnlink({ command: 0, seqnum: unlinkSeqnum, devid: DEVID, direction: 0, ep: 0 }, 0));

    // The stream is still usable, and closing does not re-reject the entry
    // that was already rejected by the abort.
    const next = device.transferIn(2, 64);
    await Promise.resolve();
    const after = transport.submittedSeqnums();
    transport.feed(retSubmitIn(after[after.length - 1]!, bytes(0x99)));
    const result = await next;
    expect(new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength)).toEqual(
      bytes(0x99),
    );

    await client.close();
  });

  it('does not reject an already-aborted transfer again when the connection closes', async () => {
    const { transport, device } = await importedDevice();

    const controller = new AbortController();
    const aborted = device.transferIn(2, 64, controller.signal);
    await Promise.resolve();
    controller.abort();
    await expect(aborted).rejects.toThrow(/abort/i);

    // A second rejection of the same promise would be an unhandled rejection.
    transport.drop(new Error('link went away'));
    await Promise.resolve();
  });
});

describe('reply dispatch', () => {
  it('rejects a transfer whose reply carries a non-zero status', async () => {
    const { transport, device } = await importedDevice();
    const pending = device.transferIn(2, 64);
    await Promise.resolve();
    const seqnums = transport.submittedSeqnums();
    transport.feed(retSubmitIn(seqnums[0]!, new Uint8Array(0), -32));
    await expect(pending).rejects.toThrow(/status -32/);
  });

  it('ignores a reply for an unknown seqnum without desyncing', async () => {
    const { transport, device } = await importedDevice();

    // A stray reply with no payload: nothing to drain, nothing to resolve.
    transport.feed(retSubmitIn(9999, new Uint8Array(0)));

    const pending = device.transferIn(2, 64);
    await Promise.resolve();
    const seqnums = transport.submittedSeqnums();
    transport.feed(retSubmitIn(seqnums[seqnums.length - 1]!, bytes(0x7f)));
    const result = await pending;
    expect(new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength)).toEqual(
      bytes(0x7f),
    );
  });
});
