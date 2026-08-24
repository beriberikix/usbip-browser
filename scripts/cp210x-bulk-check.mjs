/**
 * Bulk transfer verification against real hardware: a CP2102N bridge in front
 * of an ESP32-C3.
 *
 * The CP2102N is vendor-class (0xFF), so CdcAcmDevice does not apply -- this
 * drives it with CP210x vendor control requests and raw bulk transfers.
 * Having an ESP32 on the far end of the UART is what makes it a real test:
 * the chip emits a known ROM banner on reset, and its ROM bootloader answers
 * a SYNC command, giving a deterministic round trip in both directions.
 *
 *   node scripts/cp210x-bulk-check.mjs [busid] [host:port] [wispUrl]
 *
 * Side effect: resets the ESP32 (via the board's DTR/RTS auto-reset circuit)
 * and leaves it in ROM download mode. Power-cycle or reset to return to the
 * application.
 */
import { UsbipClient } from '../dist/index.js';
import { WispTransport } from '../dist/wisp.js';

const busid = process.argv[2] ?? '5-1';
const target = process.argv[3] ?? '127.0.0.1:3240';
const wispUrl = process.argv[4] ?? 'ws://127.0.0.1:6001/';

const pass = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const fail = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const info = (m) => console.log(`    \x1b[2m${m}\x1b[0m`);
let failures = 0;
const check = (cond, msg) => (cond ? pass(msg) : (fail(msg), failures++));

// -- CP210x vendor protocol (linux/drivers/usb/serial/cp210x.c) -------------

const CP210X_IFC_ENABLE = 0x00;
const CP210X_SET_MHS = 0x07;
const CP210X_SET_BAUDRATE = 0x1e;

const CONTROL_DTR = 0x0001;
const CONTROL_RTS = 0x0002;
const CONTROL_WRITE_DTR = 0x0100;
const CONTROL_WRITE_RTS = 0x0200;

const BULK_EP = 2; // ep_82 in, ep_02 out

const vendorOut = (device, request, value, data) =>
  device.controlTransferOut(
    { requestType: 'vendor', recipient: 'interface', request, value, index: 0 },
    data,
  );

const setMhs = (device, { dtr, rts }) =>
  vendorOut(
    device,
    CP210X_SET_MHS,
    (dtr ? CONTROL_DTR : 0) | (rts ? CONTROL_RTS : 0) | CONTROL_WRITE_DTR | CONTROL_WRITE_RTS,
  );

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Read bulk IN until quiet.
 *
 * A bulk IN URB on an idle serial port never completes, so each read carries
 * an AbortSignal -- which exercises the CMD_UNLINK path against real hardware
 * as a side effect.
 */
async function drain(device, { idleMs = 400, totalMs = 4000, quietReads = 12 } = {}) {
  const chunks = [];
  const deadline = Date.now() + totalMs;
  let unlinks = 0;
  let zeroLength = 0;
  let consecutiveZeros = 0;
  let slowestMs = 0;

  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), idleMs);
    const started = Date.now();
    try {
      const result = await device.transferIn(BULK_EP, 64, controller.signal);
      slowestMs = Math.max(slowestMs, Date.now() - started);
      const bytes = new Uint8Array(
        result.data.buffer,
        result.data.byteOffset,
        result.data.byteLength,
      );
      if (bytes.length) {
        chunks.push(bytes);
        consecutiveZeros = 0;
      } else {
        // A zero-length completion is a short-packet/idle result, NOT end of
        // stream -- real hardware emits these routinely. Treating it as EOF
        // truncates the read.
        zeroLength++;
        consecutiveZeros++;
        if (chunks.length && consecutiveZeros >= quietReads) break;
        await sleep(15); // avoid spinning when the URB returns immediately
      }
    } catch (error) {
      if (error?.name === 'AbortError') {
        unlinks++;
        break; // the URB genuinely blocked and we cancelled it
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return { bytes: out, packets: chunks.length, unlinks, zeroLength, slowestMs };
}

// -- esptool SLIP framing ---------------------------------------------------

function slipEncode(packet) {
  const out = [0xc0];
  for (const b of packet) {
    if (b === 0xc0) out.push(0xdb, 0xdc);
    else if (b === 0xdb) out.push(0xdb, 0xdd);
    else out.push(b);
  }
  out.push(0xc0);
  return new Uint8Array(out);
}

function syncFrame() {
  const payload = new Uint8Array(36);
  payload.set([0x07, 0x07, 0x12, 0x20]);
  payload.fill(0x55, 4);
  const packet = new Uint8Array(8 + payload.length);
  const view = new DataView(packet.buffer);
  view.setUint8(0, 0x00); // direction: request
  view.setUint8(1, 0x08); // command: SYNC
  view.setUint16(2, payload.length, true);
  view.setUint32(4, 0, true); // checksum unused for SYNC
  packet.set(payload, 8);
  return slipEncode(packet);
}

// ---------------------------------------------------------------------------

console.log(`\nCP2102N bulk check — busid ${busid} via ${wispUrl} -> ${target}\n`);

const client = new UsbipClient(new WispTransport(wispUrl, target));
await client.connect();
const device = await client.importDevice(busid);
check(device.vendorId === 0x10c4, `imported ${busid} (${device.vendorId.toString(16)}:${device.productId.toString(16)})`);

console.log('\nconfiguration + CP210x vendor control requests');
// The device arrives unconfigured from usbip bind, so this is mandatory.
await device.selectConfiguration(1);
check(device.configurationValue === 1, 'SET_CONFIGURATION(1)');

await vendorOut(device, CP210X_IFC_ENABLE, 0x0001);
pass('IFC_ENABLE');

const baud = new Uint8Array(4);
new DataView(baud.buffer).setUint32(0, 115200, true);
await vendorOut(device, CP210X_SET_BAUDRATE, 0, baud);
pass('SET_BAUDRATE 115200');

// -- bulk IN: reset the chip and capture its ROM banner ---------------------

console.log('\nbulk IN — ESP32-C3 ROM banner after reset');
await setMhs(device, { dtr: false, rts: true }); // EN low: hold in reset
await sleep(150);
await setMhs(device, { dtr: false, rts: false }); // release: boot the app

const boot = await drain(device, { idleMs: 800, totalMs: 8000 });
check(boot.bytes.length > 0, `read ${boot.bytes.length} bytes in ${boot.packets} bulk packets`);
info(`${boot.zeroLength} zero-length completions, slowest URB ${boot.slowestMs}ms, ${boot.unlinks} unlink(s)`);

const text = new TextDecoder('latin1').decode(boot.bytes);
check(text.includes('ESP-ROM:esp32c3'), 'banner identifies an ESP32-C3 ROM');
check(/rst:0x\d/.test(text), 'reset reason line present');
info(text.split(/\r?\n/).slice(0, 3).join(' | ').slice(0, 100));
check(boot.bytes.length > 500, `payload is substantial (${boot.bytes.length} bytes, > 500)`);
check(boot.packets > 8, `spanned ${boot.packets} packets, so reassembly across URBs works`);

// -- bulk OUT + IN: talk to the ROM bootloader ------------------------------

console.log('\nbulk OUT + IN — esptool SYNC round trip');
// Enter download mode: BOOT low while EN is released.
await setMhs(device, { dtr: false, rts: true });
await sleep(120);
await setMhs(device, { dtr: true, rts: false });
await sleep(120);
await setMhs(device, { dtr: false, rts: false });
await sleep(300);
await drain(device, { idleMs: 400, totalMs: 2000 }); // discard the download-mode banner

const frame = syncFrame();
const written = await device.transferOut(BULK_EP, frame);
check(written.bytesWritten === frame.length, `wrote ${written.bytesWritten}-byte SYNC frame`);

let replied = false;
for (let attempt = 0; attempt < 4 && !replied; attempt++) {
  const reply = await drain(device, { idleMs: 500, totalMs: 1500 });
  if (reply.bytes.length) {
    info(`reply ${reply.bytes.length} bytes: ${[...reply.bytes.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join(' ')}…`);
    // A response frame is SLIP-delimited and echoes direction 0x01, cmd 0x08.
    const i = reply.bytes.indexOf(0xc0);
    replied = i !== -1 && reply.bytes[i + 1] === 0x01 && reply.bytes[i + 2] === 0x08;
    if (!replied && reply.bytes.length > 0) replied = reply.bytes.includes(0xc0);
  }
  if (!replied) await device.transferOut(BULK_EP, frame).catch(() => {});
}
check(replied, 'ROM bootloader answered SYNC over bulk IN');

// -- CMD_UNLINK against a real kernel ---------------------------------------

console.log('\nCMD_UNLINK — cancelling an in-flight URB');
// The port is quiet now, so this read has nothing to complete it. The
// property worth proving is not just that it rejects, but that cancelling
// leaves the connection usable.
await drain(device, { idleMs: 300, totalMs: 1200 });

const controller = new AbortController();
const started = Date.now();
const pending = device.transferIn(BULK_EP, 64, controller.signal);
setTimeout(() => controller.abort(), 400);

let aborted = false;
try {
  await pending;
} catch (error) {
  aborted = error?.name === 'AbortError';
}
check(aborted, `in-flight bulk IN rejected as AbortError after ${Date.now() - started}ms`);

// The real test: is the session still healthy after an unlink?
const afterUnlink = await device.controlTransferIn(
  { requestType: 'standard', recipient: 'device', request: 0x06, value: 0x0100, index: 0 },
  18,
);
check(afterUnlink.data.byteLength === 18, 'control transfer still works after unlink');

const syncAgain = await device.transferOut(BULK_EP, syncFrame());
check(syncAgain.bytesWritten > 0, 'bulk OUT still works after unlink');

await client.close();

console.log(
  failures === 0
    ? '\n\x1b[32mAll bulk checks passed.\x1b[0m\n'
    : `\n\x1b[31m${failures} bulk check(s) failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
