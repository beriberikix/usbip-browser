/**
 * Drive the real WISP transport against a real WISP server, headlessly.
 *
 * Verifies the two things the unit tests cannot: that our handshake is
 * accepted by an independent implementation, and that flow control behaves
 * against a server that actually enforces it.
 *
 *   node scripts/live-check.mjs [wispUrl] [target] [busid]
 *
 * Requires `npm run build`, a WISP server, and something USB/IP-shaped at the
 * target (scripts/fake-usbipd.mjs will do).
 */
import { UsbipClient } from '../dist/index.js';
import { WispTransport } from '../dist/wisp.js';
import { CdcAcmDevice } from '../dist/cdc-acm.js';

const url = process.argv[2] ?? 'ws://127.0.0.1:6001/';
const target = process.argv[3] ?? '127.0.0.1:3240';
const busid = process.argv[4] ?? '1-1';

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

console.log(`\nWISP ${url}  ->  usbipd ${target}  busid ${busid}\n`);

// -- 1. list devices --------------------------------------------------------

console.log('handshake + OP_REQ_DEVLIST');
{
  const transport = new WispTransport(url, target, {
    onMotd: (motd) => console.log(`  motd: ${motd}`),
  });
  const client = new UsbipClient(transport);
  await client.connect();
  console.log(`  negotiated WISP v${transport.version}`);
  console.log(`  extensions: ${[...transport.negotiatedExtensions].map((e) => '0x' + e.toString(16)).join(', ') || 'none'}`);

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
  const client = new UsbipClient(new WispTransport(url, target));
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

console.log('\nCDC-ACM through the bridge');
{
  const client = new UsbipClient(new WispTransport(url, target));
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

  // Sustained traffic, to exercise the flow-control window rather than a
  // couple of packets that would fit in any buffer.
  let echoed = 0;
  for (let i = 0; i < 40; i++) {
    await writer.write(new TextEncoder().encode(`echo packet-${i}\r`));
    const out = await readUntil(reader, (t) => t.includes(`packet-${i}\r\n`), 40);
    if (out.includes(`packet-${i}`)) echoed++;
  }
  check(echoed === 40, `${echoed}/40 sustained round trips under flow control`);

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
