/**
 * Types for the parts of relaynet's client helper this library uses. The
 * package (https://www.npmjs.com/package/relaynet) is plain JavaScript and
 * ships no declarations.
 */
declare module 'relaynet' {
  export const RELAY_URL: string;

  export interface RelayCloseEvent {
    code: number;
    reason: string;
    /** True when reconnecting will not help (revoked token, quota). */
    final: boolean;
    retryInMs?: number;
  }

  export interface RelayOptions {
    token?: string;
    url?: string;
    onFrame?: (frame: Uint8Array) => void;
    onOpen?: (info: { reconnect: boolean }) => void;
    onClose?: (event: RelayCloseEvent) => void;
    onStateChange?: (state: 'connecting' | 'open' | 'waiting' | 'closed') => void;
    heartbeatMs?: number;
    heartbeatTimeoutMs?: number;
    initialBackoffMs?: number;
    maxBackoffMs?: number;
    checkToken?: boolean;
    WebSocket?: unknown;
    fetch?: unknown;
    window?: unknown;
  }

  export interface RelayConnection {
    /** Queues one Ethernet frame. False when it was dropped (not connected). */
    send(frame: Uint8Array): boolean;
    /** Ends the session and stops reconnecting. */
    close(): void;
  }

  export function connectRelay(options: RelayOptions): RelayConnection;
}
