/**
 * Drive the real relaynet transport through the real relay, headlessly.
 *
 * Verifies what the unit tests cannot: that relaynet leases an address,
 * routes to relaynet-bridge, and carries sustained USB/IP traffic.
 *
 *   node scripts/fake-usbipd.mjs &               # or a real usbipd
 *   relaynet-bridge -expose 3240 &               # logs its address
 *   RELAYNET_TOKEN=rr_... node scripts/live-check.mjs <bridge address:3240> [busid]
 *
 * Requires `npm run build`. See scripts/relaynet-env.mjs.
 */
import { UsbipClient } from '../dist/index.js';
import { relaynetTransport, targetFrom } from './relaynet-env.mjs';
import { CdcAcmDevice } from '../dist/cdc-acm.js';

const target = targetFrom(process.argv[2]);
const busid = process.argv[3] ?? '1-1';

const pass = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const fail = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);

let failures = 0;
function check(condition, message) {
  if (condition) pass(message);
  else {
    fail(message);
    failures++;
  }
}

async function readUntil(reader, predicate, limit = 200) {
  const decoder = new TextDecoder();
  let text = '';
  for (let i = 0; i < limit; i++) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (predicate(text)) break;
  }
  return text;
}

console.log(`\nrelaynet  ->  usbipd ${target}  busid ${busid}\n`);

// -- 1. list devices --------------------------------------------------------

console.log('relay session + DHCP + OP_REQ_DEVLIST');
{
  const transport = relaynetTransport(target);
  const client = new UsbipClient(transport);
  const started = Date.now();
  await client.connect();
  check(/^10\.0\.2\.\d+$/.test(transport.address ?? ''), `leased ${transport.address} in ${Date.now() - started} ms`);

  const devices = await client.listDevices();
  check(devices.length === 1, `listed ${devices.length} device(s)`);
  const device = devices[0];
  check(device?.busid === busid, `busid ${device?.busid}`);
  check(
    device?.vendorId === 0x2e8a && device?.productId === 0x000a,
    `id ${device?.vendorId.toString(16).padStart(4, '0')}:${device?.productId.toString(16).padStart(4, '0')}`,
  );
  check(device?.interfaces.length === 2, `${device?.interfaces.length} interface(s) decoded`);
  await client.close();
}

// -- 2. import + URB phase --------------------------------------------------

console.log('\nOP_REQ_IMPORT + URB phase');
{
  const client = new UsbipClient(relaynetTransport(target));
  await client.connect();
  const device = await client.importDevice(busid);
  check(device.busid === busid, `imported ${device.busid}`);

  await device.selectConfiguration(1);
  check(device.configurationValue === 1, 'SET_CONFIGURATION acknowledged');

  const banner = await device.transferIn(2, 128);
  const text = new TextDecoder().decode(
    new Uint8Array(banner.data.buffer, banner.data.byteOffset, banner.data.byteLength),
  );
  check(text.includes('mock device'), `bulk IN returned ${banner.data.byteLength} bytes`);

  const error = await device.transferIn(7, 8).catch((e) => e);
  check(error?.status === -32, 'stalled endpoint reported as -EPIPE');

  await client.close();
}

// -- 3. CDC-ACM over the real bridge ---------------------------------------

console.log('\nCDC-ACM through relaynet');
{
  const client = new UsbipClient(relaynetTransport(target));
  await client.connect();
  const device = await client.importDevice(busid);
  const port = await CdcAcmDevice.open(device, { baudRate: 115200 });

  const reader = port.readable.getReader();
  const banner = await readUntil(reader, (t) => t.includes('$'));
  check(banner.includes('usbip-browser mock device'), 'banner streamed');

  const writer = port.writable.getWriter();
  await writer.write(new TextEncoder().encode('id\r'));
  const response = await readUntil(reader, (t) => t.includes('busid'));
  check(response.includes('2e8a:000a'), 'command round-tripped');

  // Sustained traffic, so TCP's own window and the relay's pacing are
  // exercised rather than a couple of packets that fit in any buffer.
  let echoed = 0;
  for (let i = 0; i < 40; i++) {
    await writer.write(new TextEncoder().encode(`echo packet-${i}\r`));
    const out = await readUntil(reader, (t) => t.includes(`packet-${i}\r\n`), 40);
    if (out.includes(`packet-${i}`)) echoed++;
  }
  check(echoed === 40, `${echoed}/40 sustained round trips through the relay`);

  writer.releaseLock();
  reader.releaseLock();
  await port.close();
  await client.close();
}

console.log(
  failures === 0
    ? '\n\x1b[32mAll live checks passed.\x1b[0m\n'
    : `\n\x1b[31m${failures} live check(s) failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
