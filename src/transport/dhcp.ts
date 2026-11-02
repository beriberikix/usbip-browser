/**
 * A minimal DHCPv4 client that runs on raw Ethernet frames.
 *
 * relaynet routes traffic between an account's sessions by the leases it
 * handed out, so a session that skips DHCP and picks a static address can
 * reach the internet but never hears back from another session (such as
 * relaynet-bridge in front of a usbipd). The TCP/IP stack used here has no
 * DHCP client of its own, so the transport runs this one on the bare link
 * before the stack is attached, and again after a reconnect to win the same
 * address back.
 *
 * Only what that needs: DISCOVER -> OFFER -> REQUEST -> ACK, broadcast replies,
 * retransmission, and the options a relay sends (mask, router, lease time).
 */

const ETHERTYPE_IPV4 = 0x0800;
const IP_PROTO_UDP = 17;
const PORT_CLIENT = 68;
const PORT_SERVER = 67;
const MAGIC_COOKIE = 0x63825363;

export const DHCP_DISCOVER = 1;
export const DHCP_OFFER = 2;
export const DHCP_REQUEST = 3;
export const DHCP_ACK = 5;
export const DHCP_NAK = 6;

const OPT_SUBNET_MASK = 1;
const OPT_ROUTER = 3;
const OPT_REQUESTED_ADDRESS = 50;
const OPT_LEASE_TIME = 51;
const OPT_MESSAGE_TYPE = 53;
const OPT_SERVER_ID = 54;
const OPT_PAD = 0;
const OPT_END = 255;

export interface DhcpLease {
  /** The leased address, dotted quad. */
  address: string;
  /** Prefix length from the subnet mask (24 when the server sends none). */
  prefixLength: number;
  router?: string;
  server?: string;
  leaseSeconds?: number;
}

export interface DhcpReply {
  type: number;
  /** `yiaddr`, the address offered or acknowledged. */
  address: Uint8Array;
  server?: Uint8Array;
  mask?: Uint8Array;
  router?: Uint8Array;
  leaseSeconds?: number;
}

export class DhcpError extends Error {
  override name = 'DhcpError';
}

/** The Internet checksum (RFC 1071) over `bytes`. */
export function internetChecksum(bytes: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 2) {
    sum += (bytes[i]! << 8) | (bytes[i + 1] ?? 0);
  }
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
  return ~sum & 0xffff;
}

/**
 * One DHCP client message as a complete broadcast Ethernet frame, from
 * 0.0.0.0:68 to 255.255.255.255:67. `options` go between the message type
 * and the end marker. The UDP checksum is left at zero, which IPv4 allows.
 */
export function encodeDhcpFrame(
  mac: Uint8Array,
  xid: number,
  messageType: number,
  options: readonly number[] = [],
): Uint8Array {
  const opts = [OPT_MESSAGE_TYPE, 1, messageType, ...options, OPT_END];
  const bootp = new Uint8Array(240 + opts.length);
  const b = new DataView(bootp.buffer);
  bootp[0] = 1; // op: BOOTREQUEST
  bootp[1] = 1; // htype: Ethernet
  bootp[2] = 6; // hlen
  b.setUint32(4, xid);
  b.setUint16(10, 0x8000); // flags: broadcast, since we cannot receive unicast yet
  bootp.set(mac, 28);
  b.setUint32(236, MAGIC_COOKIE);
  bootp.set(opts, 240);

  const frame = new Uint8Array(14 + 20 + 8 + bootp.length);
  const f = new DataView(frame.buffer);
  frame.fill(0xff, 0, 6);
  frame.set(mac, 6);
  f.setUint16(12, ETHERTYPE_IPV4);

  const ip = 14;
  frame[ip] = 0x45;
  f.setUint16(ip + 2, 20 + 8 + bootp.length);
  frame[ip + 8] = 64; // TTL
  frame[ip + 9] = IP_PROTO_UDP;
  frame.fill(0xff, ip + 16, ip + 20); // destination 255.255.255.255; source stays 0.0.0.0
  f.setUint16(ip + 10, internetChecksum(frame.subarray(ip, ip + 20)));

  const udp = ip + 20;
  f.setUint16(udp, PORT_CLIENT);
  f.setUint16(udp + 2, PORT_SERVER);
  f.setUint16(udp + 4, 8 + bootp.length);

  frame.set(bootp, udp + 8);
  return frame;
}

/** A DHCP reply for transaction `xid` in `frame`, or null for anything else. */
export function decodeDhcpReply(frame: Uint8Array, xid: number): DhcpReply | null {
  if (frame.length < 14 + 20 + 8 + 240) return null;
  const f = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  if (f.getUint16(12) !== ETHERTYPE_IPV4) return null;
  const ip = 14;
  if (frame[ip]! >> 4 !== 4 || frame[ip + 9] !== IP_PROTO_UDP) return null;
  const udp = ip + (frame[ip]! & 0x0f) * 4;
  if (f.getUint16(udp) !== PORT_SERVER || f.getUint16(udp + 2) !== PORT_CLIENT) return null;
  const bootp = udp + 8;
  if (frame.length < bootp + 240) return null;
  if (frame[bootp] !== 2) return null; // op: BOOTREPLY
  if (f.getUint32(bootp + 4) !== xid) return null;
  if (f.getUint32(bootp + 236) !== MAGIC_COOKIE) return null;

  const reply: DhcpReply = { type: 0, address: frame.slice(bootp + 16, bootp + 20) };
  for (let i = bootp + 240; i < frame.length; ) {
    const code = frame[i]!;
    if (code === OPT_END) break;
    if (code === OPT_PAD) {
      i += 1;
      continue;
    }
    const len = frame[i + 1];
    if (len === undefined || i + 2 + len > frame.length) break;
    const value = frame.slice(i + 2, i + 2 + len);
    if (code === OPT_MESSAGE_TYPE && len >= 1) reply.type = value[0]!;
    else if (code === OPT_SERVER_ID && len >= 4) reply.server = value.subarray(0, 4);
    else if (code === OPT_SUBNET_MASK && len >= 4) reply.mask = value.subarray(0, 4);
    else if (code === OPT_ROUTER && len >= 4) reply.router = value.subarray(0, 4);
    else if (code === OPT_LEASE_TIME && len >= 4) reply.leaseSeconds = new DataView(value.buffer).getUint32(0);
    i += 2 + len;
  }
  return reply.type ? reply : null;
}

const dotted = (bytes: Uint8Array): string => Array.from(bytes).join('.');

function prefixLength(mask: Uint8Array | undefined): number {
  if (!mask) return 24;
  let bits = 0;
  for (const byte of mask) for (let b = 7; b >= 0; b--) if (byte & (1 << b)) bits++;
  return bits;
}

export interface RequestLeaseOptions {
  /** Give up after this long. Default 10000 ms. */
  timeoutMs?: number;
  /** Send DISCOVER again this often until an OFFER arrives. Default 2000 ms. */
  retransmitMs?: number;
}

/**
 * Obtain a lease over a raw link.
 *
 * @param mac        this interface's MAC address
 * @param send       puts one Ethernet frame on the link
 * @param subscribe  installs a handler for every frame the link receives and
 *                   returns a function that removes it. The handler returns
 *                   true when it consumed the frame (a reply to this client).
 */
export function requestLease(
  mac: Uint8Array,
  send: (frame: Uint8Array) => void,
  subscribe: (handler: (frame: Uint8Array) => boolean) => () => void,
  { timeoutMs = 10_000, retransmitMs = 2_000 }: RequestLeaseOptions = {},
): Promise<DhcpLease> {
  const xid = crypto.getRandomValues(new Uint32Array(1))[0]!;
  return new Promise<DhcpLease>((resolve, reject) => {
    let requested = false;
    const finish = (error: Error | null, lease?: DhcpLease): void => {
      clearTimeout(timer);
      clearInterval(retransmit);
      unsubscribe();
      if (error) reject(error);
      else resolve(lease!);
    };
    const timer = setTimeout(
      () => finish(new DhcpError(`no DHCP lease within ${timeoutMs} ms`)),
      timeoutMs,
    );
    const retransmit = setInterval(() => {
      if (!requested) send(encodeDhcpFrame(mac, xid, DHCP_DISCOVER));
    }, retransmitMs);
    const unsubscribe = subscribe((frame) => {
      const reply = decodeDhcpReply(frame, xid);
      if (!reply) return false;
      if (reply.type === DHCP_OFFER && !requested) {
        requested = true;
        const options = [OPT_REQUESTED_ADDRESS, 4, ...reply.address];
        if (reply.server) options.push(OPT_SERVER_ID, 4, ...reply.server);
        send(encodeDhcpFrame(mac, xid, DHCP_REQUEST, options));
      } else if (reply.type === DHCP_ACK) {
        const lease: DhcpLease = {
          address: dotted(reply.address),
          prefixLength: prefixLength(reply.mask),
        };
        if (reply.router) lease.router = dotted(reply.router);
        if (reply.server) lease.server = dotted(reply.server);
        if (reply.leaseSeconds !== undefined) lease.leaseSeconds = reply.leaseSeconds;
        finish(null, lease);
      } else if (reply.type === DHCP_NAK) {
        finish(new DhcpError('the DHCP server refused the request (NAK)'));
      }
      return true;
    });
    send(encodeDhcpFrame(mac, xid, DHCP_DISCOVER));
  });
}
