/**
 * How the check scripts reach a usbipd: through relaynet, to relaynet-bridge
 * running next to it.
 *
 *   On the machine with the device:   relaynet-bridge -expose 3240
 *   Here:                             export RELAYNET_TOKEN=rr_...
 *                                     node scripts/<check>.mjs <busid> <bridge address:3240>
 *
 * The token comes from RELAYNET_TOKEN or the file named by
 * RELAYNET_TOKEN_FILE, never from the command line, where other users can
 * see it. RELAYNET_URL picks another relay, such as a self-hosted
 * rootlessRelay (ws://127.0.0.1:8086/, which needs no token).
 */
import fs from 'node:fs';
import { RelaynetTransport } from '../dist/relaynet.js';

function token() {
  if (process.env.RELAYNET_TOKEN) return process.env.RELAYNET_TOKEN.trim();
  if (process.env.RELAYNET_TOKEN_FILE) return fs.readFileSync(process.env.RELAYNET_TOKEN_FILE, 'utf8').trim();
  return undefined;
}

/** The usbipd's address on the relay's network, from argv or USBIP_TARGET. */
export function targetFrom(arg) {
  const target = arg ?? process.env.USBIP_TARGET;
  if (!target) {
    console.error(
      '\nNo target. Pass the address relaynet-bridge logged, such as 10.0.2.15:3240,\n' +
        'or set USBIP_TARGET.\n',
    );
    process.exit(2);
  }
  return target;
}

/** A RelaynetTransport to `target`, configured from the environment. */
export function relaynetTransport(target, options = {}) {
  const url = process.env.RELAYNET_URL;
  const t = token();
  if (!t && !url) {
    console.error('\nSet RELAYNET_TOKEN (or RELAYNET_TOKEN_FILE) to an API token from relaynet.network.\n');
    process.exit(2);
  }
  return new RelaynetTransport(target, {
    ...(t && { token: t }),
    ...(url && { url }),
    onStatus: (line) => console.log(`  \x1b[2m[relaynet] ${line}\x1b[0m`),
    ...options,
  });
}
