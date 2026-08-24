/**
 * Verify the client against a real usbipd and real hardware.
 *
 * Read-only by design: it lists, imports, and reads descriptors over endpoint
 * 0. It does not write to the device, change line settings, or touch bulk
 * endpoints, so it is safe to point at a device without knowing what is on
 * the other end of it.
 *
 *   node scripts/hw-check.mjs [busid] [host:port]
 *
 * Requires `npm run build` and a usbipd with the device bound.
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

const hex4 = (n) => n.toString(16).padStart(4, '0');
const view2bytes = (v) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);

console.log(`\nusbipd ${target} via WISP ${wispUrl}, busid ${busid}\n`);

// -- 1. What does the daemon say is there? ----------------------------------

console.log('OP_REQ_DEVLIST against real usbipd');
const listClient = new UsbipClient(new WispTransport(wispUrl, target));
await listClient.connect();
const devices = await listClient.listDevices();
await listClient.close();

check(devices.length > 0, `daemon exported ${devices.length} device(s)`);
for (const d of devices) {
  info(`${d.busid.padEnd(10)} ${hex4(d.vendorId)}:${hex4(d.productId)}  ${d.speed}  ${d.numInterfaces} iface(s)`);
}

const listed = devices.find((d) => d.busid === busid);
check(Boolean(listed), `busid ${busid} present in the listing`);
if (!listed) {
  console.log(`\n\x1b[31mNot exported. Run: sudo usbip bind -b ${busid}\x1b[0m\n`);
  process.exit(1);
}
check(listed.path.startsWith('/sys/devices'), `sysfs path decoded: ${listed.path.slice(0, 48)}…`);
check(
  listed.interfaces.length === listed.numInterfaces,
  `interfaces array length (${listed.interfaces.length}) matches numInterfaces`,
);
if (listed.configurationValue === 0) {
  info('bConfigurationValue is 0: usbipd leaves a freshly bound device');
  info('unconfigured, so it reports no active interfaces. Expected.');
  check(listed.numInterfaces === 0, 'unconfigured device reports 0 interfaces, consistently');
}
for (const [i, iface] of listed.interfaces.entries()) {
  info(
    `iface ${i}: class 0x${iface.interfaceClass.toString(16).padStart(2, '0')} ` +
      `subclass 0x${iface.interfaceSubClass.toString(16).padStart(2, '0')} ` +
      `protocol 0x${iface.interfaceProtocol.toString(16).padStart(2, '0')}`,
  );
}

// -- 2. Import and read the real descriptors --------------------------------

console.log('\nOP_REQ_IMPORT + control transfers on endpoint 0');
const client = new UsbipClient(new WispTransport(wispUrl, target));
await client.connect();
const device = await client.importDevice(busid);
check(device.busid === busid, `imported ${busid}`);
info(`reported configuration: ${device.configurationValue ?? 'none'}`);

const GET_DESCRIPTOR = 0x06;
const descriptorIn = (type, index, length) =>
  device.controlTransferIn(
    { requestType: 'standard', recipient: 'device', request: GET_DESCRIPTOR, value: (type << 8) | index, index: 0 },
    length,
  );

// Device descriptor: 18 bytes, and its idVendor/idProduct must agree with
// what OP_REP_DEVLIST reported. Two independent paths to the same fact.
const dev = await descriptorIn(0x01, 0, 18);
const d = view2bytes(dev.data);
check(d.length === 18, `device descriptor returned ${d.length} bytes`);
check(d[0] === 18 && d[1] === 0x01, `bLength=${d[0]} bDescriptorType=0x${d[1]?.toString(16)}`);

const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
const idVendor = dv.getUint16(8, true); // descriptors are little-endian
const idProduct = dv.getUint16(10, true);
const bcdUSB = dv.getUint16(2, true);
info(`bcdUSB ${(bcdUSB >> 8).toString(16)}.${((bcdUSB >> 4) & 0xf).toString(16)}  ` +
  `idVendor ${hex4(idVendor)}  idProduct ${hex4(idProduct)}  ` +
  `bNumConfigurations ${d[17]}`);
check(
  idVendor === listed.vendorId && idProduct === listed.productId,
  `descriptor ids match the device list (${hex4(idVendor)}:${hex4(idProduct)})`,
);

// Configuration descriptor: read the 9-byte header, then the full tree. This
// is the real test of the control path -- a two-stage read where the second
// length comes from the first response.
const cfgHead = await descriptorIn(0x02, 0, 9);
const ch = view2bytes(cfgHead.data);
const wTotalLength = new DataView(ch.buffer, ch.byteOffset, ch.byteLength).getUint16(2, true);
check(ch.length === 9 && ch[1] === 0x02, `config header returned ${ch.length} bytes`);
info(`wTotalLength ${wTotalLength}  bNumInterfaces ${ch[4]}  bConfigurationValue ${ch[5]}`);

const cfgFull = await descriptorIn(0x02, 0, wTotalLength);
const cf = view2bytes(cfgFull.data);
check(cf.length === wTotalLength, `full config descriptor returned ${cf.length}/${wTotalLength} bytes`);

// Walk the descriptor tree; this proves we got real structured bytes back,
// not padding.
let offset = 0;
let interfaces = 0;
let endpoints = 0;
while (offset + 1 < cf.length) {
  const len = cf[offset];
  const type = cf[offset + 1];
  if (!len) break;
  if (type === 0x04) interfaces++;
  if (type === 0x05) endpoints++;
  offset += len;
}
check(offset === cf.length, `descriptor tree walks cleanly to ${offset} bytes`);
check(interfaces === ch[4], `${interfaces} interface descriptor(s), matching bNumInterfaces`);
info(`${endpoints} endpoint descriptor(s) found`);

// String descriptors, if the device advertises them.
const iManufacturer = d[14];
const iProduct = d[15];
for (const [label, index] of [['manufacturer', iManufacturer], ['product', iProduct]]) {
  if (!index) continue;
  try {
    const head = await descriptorIn(0x03, index, 2);
    const total = view2bytes(head.data)[0];
    const full = await descriptorIn(0x03, index, total);
    const bytes = view2bytes(full.data);
    const text = new TextDecoder('utf-16le').decode(bytes.subarray(2));
    check(text.length > 0, `${label} string: ${JSON.stringify(text)}`);
  } catch (error) {
    info(`${label} string unavailable: ${error.message}`);
  }
}

await client.close();

console.log(
  failures === 0
    ? '\n\x1b[32mAll hardware checks passed.\x1b[0m\n'
    : `\n\x1b[31m${failures} hardware check(s) failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
