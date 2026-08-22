/**
 * Interrupt endpoint verification, using a HID keyboard gadget.
 *
 * Interrupt transfers are the one endpoint type this library supports but has
 * never exercised against a kernel. They differ from bulk in scheduling
 * rather than in the URB format, so the interesting questions are whether a
 * report arrives intact and whether an idle interrupt IN behaves sanely --
 * it should block, not busy-return, and must be cancellable.
 *
 * The gadget's far side is /dev/hidg0, so reports are injected on demand.
 *
 *   sudo scripts/vudc-setup.sh hid
 *   node scripts/hid-check.mjs [busid]
 */
import fs from 'node:fs';
import { UsbipClient } from '../dist/index.js';
import { WispTransport } from '../dist/wisp.js';

const busid = process.argv[2] ?? 'usbip-vudc.0';
const target = process.argv[3] ?? '127.0.0.1:3240';
const wispUrl = process.argv[4] ?? 'ws://127.0.0.1:6001/';
const GADGET_HID = '/dev/hidg0';

const pass = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const fail = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const info = (m) => console.log(`    \x1b[2m${m}\x1b[0m`);
let failures = 0;
const check = (cond, msg) => (cond ? pass(msg) : (fail(msg), failures++));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toBytes = (v) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');

if (!fs.existsSync(GADGET_HID)) {
  console.error(`\n${GADGET_HID} not present. Run: sudo scripts/vudc-setup.sh hid\n`);
  process.exit(1);
}

/** Find the interrupt IN endpoint by walking the configuration descriptor. */
function findInterruptIn(config) {
  let offset = 0;
  let interfaceNumber = null;
  while (offset + 1 < config.length) {
    const length = config[offset];
    const type = config[offset + 1];
    if (!length) break;
    if (type === 0x04) interfaceNumber = config[offset + 2];
    if (type === 0x05) {
      const address = config[offset + 2];
      const attributes = config[offset + 3];
      if ((attributes & 0x03) === 0x03 && address & 0x80) {
        return {
          endpoint: address & 0x0f,
          interfaceNumber,
          interval: config[offset + 6],
          maxPacket: config[offset + 4] | (config[offset + 5] << 8),
        };
      }
    }
    offset += length;
  }
  return null;
}

console.log(`\nHID gadget, interrupt endpoints — busid ${busid}\n`);

const gadget = fs.openSync(GADGET_HID, 'r+');
/** Press and release a key, producing two 8-byte reports. */
function sendKey(keycode, modifier = 0) {
  const down = Buffer.from([modifier, 0, keycode, 0, 0, 0, 0, 0]);
  fs.writeSync(gadget, down);
  fs.writeSync(gadget, Buffer.alloc(8)); // release
}

const client = new UsbipClient(new WispTransport(wispUrl, target));
await client.connect();
const device = await client.importDevice(busid);
check(device.vendorId === 0x1d6b, `imported ${busid} (${device.vendorId.toString(16)}:${device.productId.toString(16)})`);

await device.selectConfiguration(1);
pass('SET_CONFIGURATION(1)');

const head = await device.controlTransferIn(
  { requestType: 'standard', recipient: 'device', request: 0x06, value: 0x0200, index: 0 },
  9,
);
const headBytes = toBytes(head.data);
const totalLength = new DataView(headBytes.buffer, headBytes.byteOffset).getUint16(2, true);
const config = toBytes(
  (
    await device.controlTransferIn(
      { requestType: 'standard', recipient: 'device', request: 0x06, value: 0x0200, index: 0 },
      totalLength,
    )
  ).data,
);

const ep = findInterruptIn(config);
check(Boolean(ep), 'located an interrupt IN endpoint in the config descriptor');
if (!ep) {
  await client.close();
  process.exit(1);
}
info(`interface ${ep.interfaceNumber}, endpoint ${ep.endpoint}, wMaxPacketSize ${ep.maxPacket}, bInterval ${ep.interval}`);

// -- HID class descriptor ---------------------------------------------------

console.log('\nHID report descriptor (class-specific GET_DESCRIPTOR)');
// Descriptor type 0x22 is the HID report descriptor, fetched with recipient
// = interface -- a different shape from the device-recipient reads elsewhere.
const report = await device.controlTransferIn(
  {
    requestType: 'standard',
    recipient: 'interface',
    request: 0x06,
    value: 0x2200,
    index: ep.interfaceNumber,
  },
  63,
);
const reportBytes = toBytes(report.data);
check(reportBytes.length === 63, `report descriptor is ${reportBytes.length} bytes`);
check(
  reportBytes[0] === 0x05 && reportBytes[1] === 0x01 && reportBytes[2] === 0x09 && reportBytes[3] === 0x06,
  'begins with Usage Page (Generic Desktop), Usage (Keyboard)',
);

// -- interrupt IN -----------------------------------------------------------

console.log('\ninterrupt IN transfers');
// Queue the read first, then generate the report, so the URB is genuinely
// pending when the data arrives -- which is how interrupt endpoints are used.
const pending = device.transferIn(ep.endpoint, 8);
await sleep(150);
sendKey(0x04); // 'a'

const first = toBytes((await pending).data);
check(first.length === 8, `received an 8-byte report: ${hex(first)}`);
check(first[2] === 0x04, "report carries keycode 0x04 ('a')");

const release = toBytes((await device.transferIn(ep.endpoint, 8)).data);
check(release.every((b) => b === 0), `release report is all zeros: ${hex(release)}`);

// -- several reports in sequence --------------------------------------------

console.log('\nsequence of reports');
const keycodes = [0x05, 0x06, 0x07, 0x08, 0x09]; // b c d e f
for (const code of keycodes) sendKey(code);

const received = [];
for (let i = 0; i < keycodes.length * 2; i++) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const bytes = toBytes((await device.transferIn(ep.endpoint, 8, controller.signal)).data);
    if (bytes[2]) received.push(bytes[2]);
  } catch (error) {
    if (error?.name === 'AbortError') break;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
check(
  keycodes.every((c) => received.includes(c)),
  `received keycodes ${received.map((c) => '0x' + c.toString(16)).join(', ')}`,
);

// -- idle behaviour and cancellation ----------------------------------------

console.log('\nidle interrupt IN');
const controller = new AbortController();
const started = Date.now();
const idle = device.transferIn(ep.endpoint, 8, controller.signal);
setTimeout(() => controller.abort(), 600);

let aborted = false;
try {
  const bytes = toBytes((await idle).data);
  info(`unexpectedly completed with ${bytes.length} bytes: ${hex(bytes)}`);
} catch (error) {
  aborted = error?.name === 'AbortError';
}
const elapsed = Date.now() - started;
check(aborted, `idle interrupt IN blocked and was cancelled after ${elapsed}ms`);
check(elapsed >= 500, 'it blocked rather than busy-returning');

// The connection must still be healthy after cancelling an interrupt URB.
const afterUnlink = await device.controlTransferIn(
  { requestType: 'standard', recipient: 'device', request: 0x06, value: 0x0100, index: 0 },
  18,
);
check(afterUnlink.data.byteLength === 18, 'control transfer still works after unlink');

sendKey(0x0a);
const resumed = toBytes((await device.transferIn(ep.endpoint, 8)).data);
check(resumed[2] === 0x0a, 'interrupt endpoint still delivers after an unlink');

await client.close();
fs.closeSync(gadget);

console.log(
  failures === 0
    ? '\n\x1b[32mAll interrupt-endpoint checks passed.\x1b[0m\n'
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
