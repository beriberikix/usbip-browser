/**
 * CdcAcmDevice against a real CDC-ACM device.
 *
 * The device is a Linux usb_f_acm gadget on a virtual UDC, so its far side is
 * /dev/ttyGS0 on this machine. That is what makes these assertions strong:
 * the exact bytes the device sends, and the exact moments it goes idle, are
 * chosen here rather than hoped for.
 *
 * The idle gap in the middle is the point. A zero-length bulk IN completion
 * used to leave CdcAcmDevice.readable permanently stalled, so the second
 * batch would never arrive.
 *
 *   sudo scripts/vudc-setup.sh acm
 *   node scripts/cdc-acm-check.mjs [busid]
 */
import fs from 'node:fs';
import { UsbipClient } from '../dist/index.js';
import { WispTransport } from '../dist/wisp.js';
import { CdcAcmDevice } from '../dist/cdc-acm.js';

const busid = process.argv[2] ?? 'usbip-vudc.0';
const target = process.argv[3] ?? '127.0.0.1:3240';
const wispUrl = process.argv[4] ?? 'ws://127.0.0.1:6001/';
const GADGET_TTY = '/dev/ttyGS0';

const pass = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const fail = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const info = (m) => console.log(`    \x1b[2m${m}\x1b[0m`);
let failures = 0;
const check = (cond, msg) => (cond ? pass(msg) : (fail(msg), failures++));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(GADGET_TTY)) {
  console.error(`\n${GADGET_TTY} not present. Run: sudo scripts/vudc-setup.sh acm\n`);
  process.exit(1);
}

console.log(`\nCDC-ACM gadget — busid ${busid}\n`);

// The gadget side. Writes here travel to our USB/IP client; reads here
// receive what the client sends.
const gadget = fs.openSync(GADGET_TTY, 'r+');
const sendFromDevice = (text) => fs.writeSync(gadget, Buffer.from(text));

// Deliberately no listDevices() here. usbip-vudc accepts one attachment at a
// time, and the connection churn of listing, disconnecting and reconnecting
// tears the gadget down underneath the import that follows. `usbip list -d`
// on the host covers the listing case; hw-check.mjs covers OP_REQ_DEVLIST
// against a real device.
const client = new UsbipClient(new WispTransport(wispUrl, target));
await client.connect();
const device = await client.importDevice(busid);
check(device.vendorId === 0x1d6b, `imported ${busid} (${device.vendorId.toString(16)}:${device.productId.toString(16)})`);

// The CDC-ACM control requests -- SET_LINE_CODING and SET_CONTROL_LINE_STATE
// -- have only ever run against the emulator until now.
const port = await CdcAcmDevice.open(device, { baudRate: 115200 });
pass('CdcAcmDevice.open() completed against a real ACM device');
check(device.configurationValue === 1, 'SET_CONFIGURATION(1) on an unconfigured gadget');

const reader = port.readable.getReader();
const decoder = new TextDecoder();

async function readFor(ms) {
  let text = '';
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const result = await Promise.race([reader.read(), sleep(ms).then(() => null)]);
    if (!result || result.done) break;
    text += decoder.decode(result.value, { stream: true });
    if (Date.now() >= deadline) break;
  }
  return text;
}

// -- 1. device -> host ------------------------------------------------------

console.log('\ndevice to host');
sendFromDevice('FIRST-BATCH\r\n');
const first = await readFor(1500);
check(first.includes('FIRST-BATCH'), `received ${JSON.stringify(first.trim())}`);

// -- 2. the stall regression ------------------------------------------------

console.log('\nidle gap, then a second batch (the stall regression)');
info('an idle bulk IN used to leave the stream permanently stalled');
await sleep(1200); // long enough for an idle/zero-length completion
sendFromDevice('SECOND-BATCH\r\n');
const second = await readFor(2500);
check(
  second.includes('SECOND-BATCH'),
  second.includes('SECOND-BATCH')
    ? 'stream survived the idle gap'
    : 'stream stalled after going idle — the regression is back',
);

// -- 3. host -> device ------------------------------------------------------

console.log('\nhost to device');
const writer = port.writable.getWriter();
await writer.write(new TextEncoder().encode('FROM-CLIENT\n'));
await sleep(400);

let received = '';
try {
  const buffer = Buffer.alloc(256);
  const n = fs.readSync(gadget, buffer, 0, buffer.length, null);
  received = buffer.subarray(0, n).toString();
} catch (error) {
  if (error.code !== 'EAGAIN') throw error;
}
check(received.includes('FROM-CLIENT'), `gadget received ${JSON.stringify(received.trim())}`);

// -- 4. sustained streaming -------------------------------------------------

console.log('\nsustained streaming across many URBs');
const lines = 40;
for (let i = 0; i < lines; i++) {
  sendFromDevice(`line-${i.toString().padStart(3, '0')}\r\n`);
  if (i % 8 === 0) await sleep(30); // interleave idle moments
}
const bulk = await readFor(4000);
const seen = [...bulk.matchAll(/line-(\d{3})/g)].map((m) => Number(m[1]));
const unique = new Set(seen);
check(unique.size === lines, `received ${unique.size}/${lines} lines in order across URBs`);
if (unique.size !== lines) {
  const missing = [...Array(lines).keys()].filter((i) => !unique.has(i));
  info(`missing: ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? '…' : ''}`);
}
check(
  seen.every((v, i) => i === 0 || v >= seen[i - 1]),
  'no reordering across URB boundaries',
);

writer.releaseLock();
reader.releaseLock();
await port.close();
await client.close();
fs.closeSync(gadget);

console.log(
  failures === 0
    ? '\n\x1b[32mAll CDC-ACM checks passed.\x1b[0m\n'
    : `\n\x1b[31m${failures} CDC-ACM check(s) failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
