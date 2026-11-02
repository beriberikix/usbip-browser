import { describe, expect, it } from 'vitest';
import {
  DHCP_ACK,
  DHCP_DISCOVER,
  DHCP_NAK,
  DHCP_OFFER,
  DHCP_REQUEST,
  DhcpError,
  decodeDhcpReply,
  encodeDhcpFrame,
  internetChecksum,
  requestLease,
} from '../src/transport/dhcp.js';

const MAC = new Uint8Array([0x02, 0, 0, 0, 0, 0x01]);

/** A BOOTREPLY frame as a relay sends it. */
function reply(xid: number, type: number, address = [10, 0, 2, 16], extra: number[] = []): Uint8Array {
  const opts = [53, 1, type, 54, 4, 10, 0, 2, 2, 1, 4, 255, 255, 255, 0, 3, 4, 10, 0, 2, 2, 51, 4, 0, 0, 0x0e, 0x10, ...extra, 255];
  const frame = new Uint8Array(42 + 240 + opts.length);
  const f = new DataView(frame.buffer);
  f.setUint16(12, 0x0800);
  frame[14] = 0x45;
  frame[23] = 17;
  f.setUint16(34, 67);
  f.setUint16(36, 68);
  frame[42] = 2;
  f.setUint32(46, xid);
  frame.set(address, 58);
  f.setUint32(42 + 236, 0x63825363);
  frame.set(opts, 42 + 240);
  return frame;
}

const optionType = (frame: Uint8Array): number => frame[42 + 242]!;
const xidOf = (frame: Uint8Array): number => new DataView(frame.buffer).getUint32(46);

describe('encodeDhcpFrame', () => {
  const frame = encodeDhcpFrame(MAC, 0x01020304, DHCP_DISCOVER);

  it('is a broadcast from 0.0.0.0:68 to 255.255.255.255:67', () => {
    expect([...frame.subarray(0, 6)]).toEqual([255, 255, 255, 255, 255, 255]);
    expect([...frame.subarray(6, 12)]).toEqual([...MAC]);
    expect([...frame.subarray(26, 30)]).toEqual([0, 0, 0, 0]);
    expect([...frame.subarray(30, 34)]).toEqual([255, 255, 255, 255]);
    const v = new DataView(frame.buffer);
    expect(v.getUint16(34)).toBe(68);
    expect(v.getUint16(36)).toBe(67);
  });

  it('has a valid IPv4 header checksum', () => {
    expect(internetChecksum(frame.subarray(14, 34))).toBe(0);
  });

  it('carries the transaction id, chaddr, broadcast flag and message type', () => {
    const v = new DataView(frame.buffer);
    expect(v.getUint32(46)).toBe(0x01020304);
    expect(v.getUint16(42 + 10)).toBe(0x8000);
    expect([...frame.subarray(42 + 28, 42 + 34)]).toEqual([...MAC]);
    expect(optionType(frame)).toBe(DHCP_DISCOVER);
  });
});

describe('decodeDhcpReply', () => {
  it('reads the address and options', () => {
    const r = decodeDhcpReply(reply(7, DHCP_ACK), 7)!;
    expect(r.type).toBe(DHCP_ACK);
    expect([...r.address]).toEqual([10, 0, 2, 16]);
    expect([...r.server!]).toEqual([10, 0, 2, 2]);
    expect([...r.mask!]).toEqual([255, 255, 255, 0]);
    expect(r.leaseSeconds).toBe(3600);
  });

  it('ignores another transaction, and anything that is not DHCP', () => {
    expect(decodeDhcpReply(reply(7, DHCP_ACK), 8)).toBeNull();
    expect(decodeDhcpReply(new Uint8Array(60), 7)).toBeNull();
  });

  it('skips pad options', () => {
    expect(decodeDhcpReply(reply(7, DHCP_OFFER, undefined, [0, 0, 0]), 7)?.type).toBe(DHCP_OFFER);
  });
});

/** A link whose far end is a scripted DHCP server. */
function link(server: (frame: Uint8Array, respond: (f: Uint8Array) => void) => void) {
  const sent: Uint8Array[] = [];
  let handler: ((f: Uint8Array) => boolean) | null = null;
  return {
    sent,
    send: (frame: Uint8Array) => {
      sent.push(frame);
      queueMicrotask(() => server(frame, (f) => handler?.(f)));
    },
    subscribe: (h: (f: Uint8Array) => boolean) => {
      handler = h;
      return () => {
        handler = null;
      };
    },
  };
}

describe('requestLease', () => {
  it('runs DISCOVER, OFFER, REQUEST, ACK', async () => {
    const l = link((frame, respond) => {
      const type = optionType(frame);
      if (type === DHCP_DISCOVER) respond(reply(xidOf(frame), DHCP_OFFER));
      if (type === DHCP_REQUEST) respond(reply(xidOf(frame), DHCP_ACK));
    });
    const lease = await requestLease(MAC, l.send, l.subscribe);
    expect(lease).toEqual({ address: '10.0.2.16', prefixLength: 24, router: '10.0.2.2', server: '10.0.2.2', leaseSeconds: 3600 });
    expect(l.sent.map(optionType)).toEqual([DHCP_DISCOVER, DHCP_REQUEST]);
    // The REQUEST names the offered address (50) and the server (54).
    const request = l.sent[1]!;
    const opts = [...request.subarray(42 + 240)];
    expect(opts.slice(3, 9)).toEqual([50, 4, 10, 0, 2, 16]);
    expect(opts.slice(9, 15)).toEqual([54, 4, 10, 0, 2, 2]);
  });

  it('retransmits DISCOVER until an OFFER arrives', async () => {
    let discovers = 0;
    const l = link((frame, respond) => {
      const type = optionType(frame);
      if (type === DHCP_DISCOVER && ++discovers === 3) respond(reply(xidOf(frame), DHCP_OFFER));
      if (type === DHCP_REQUEST) respond(reply(xidOf(frame), DHCP_ACK));
    });
    await requestLease(MAC, l.send, l.subscribe, { retransmitMs: 10 });
    expect(discovers).toBe(3);
  });

  it('rejects on NAK', async () => {
    const l = link((frame, respond) => {
      if (optionType(frame) === DHCP_DISCOVER) respond(reply(xidOf(frame), DHCP_OFFER));
      else respond(reply(xidOf(frame), DHCP_NAK));
    });
    await expect(requestLease(MAC, l.send, l.subscribe)).rejects.toThrow(DhcpError);
  });

  it('times out when nothing answers', async () => {
    const l = link(() => {});
    await expect(requestLease(MAC, l.send, l.subscribe, { timeoutMs: 50, retransmitMs: 10 })).rejects.toThrow(
      /no DHCP lease within 50 ms/,
    );
  });

  it('passes on frames that are not its replies', async () => {
    const l = link((frame, respond) => {
      if (optionType(frame) === DHCP_DISCOVER) {
        expect(l.subscribeResult(new Uint8Array(60))).toBe(false);
        respond(reply(xidOf(frame), DHCP_OFFER));
      } else respond(reply(xidOf(frame), DHCP_ACK));
    }) as ReturnType<typeof link> & { subscribeResult: (f: Uint8Array) => boolean };
    const subscribe = l.subscribe;
    l.subscribe = (h) => {
      l.subscribeResult = h;
      return subscribe(h);
    };
    await requestLease(MAC, l.send, l.subscribe);
  });
});
