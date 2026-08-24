/**
 * USB Mass Storage over USB/IP — the class WebUSB refuses to touch.
 *
 * Chrome blocks `claimInterface` on interface class 0x08, so a web page can
 * never speak to a flash drive through WebUSB. This library is a protocol
 * client rather than a USB host, so the blocklist does not apply: the remote
 * kernel does the USB work and we exchange URBs. This script demonstrates
 * that end to end.
 *
 * STRICTLY READ-ONLY. It issues INQUIRY, READ CAPACITY (10), and READ (10) of
 * logical block 0. It never writes to the medium.
 *
 *   node scripts/msc-check.mjs [busid] [host:port] [wispUrl]
 *
 * Unmount the device before binding it with usbip.
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

const ascii = (b) => new TextDecoder('latin1').decode(b).replace(/\0/g, ' ').trim();
const toBytes = (v) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);

// -- Bulk-Only Transport (USB MSC BBB) --------------------------------------

const CBW_SIGNATURE = 0x43425355; // 'USBC'
const CSW_SIGNATURE = 0x53425355; // 'USBS'

let tag = 1;

function buildCbw(dataLength, dirIn, cdb, lun = 0) {
  const cbw = new Uint8Array(31);
  const view = new DataView(cbw.buffer);
  view.setUint32(0, CBW_SIGNATURE, true);
  view.setUint32(4, tag, true);
  view.setUint32(8, dataLength, true);
  view.setUint8(12, dirIn ? 0x80 : 0x00);
  view.setUint8(13, lun & 0x0f);
  view.setUint8(14, cdb.length);
  cbw.set(cdb, 15);
  return cbw;
}

/** Issue one SCSI command: CBW out, data in, CSW in. */
async function scsiIn(device, eps, cdb, dataLength) {
  const myTag = tag;
  await device.transferOut(eps.out, buildCbw(dataLength, true, cdb));

  let data = new Uint8Array(0);
  let packets = 0;
  if (dataLength > 0) {
    const collected = [];
    let got = 0;
    while (got < dataLength) {
      const chunk = toBytes((await device.transferIn(eps.in, dataLength - got)).data);
      if (!chunk.length) break;
      collected.push(chunk);
      got += chunk.length;
    }
    data = new Uint8Array(got);
    let o = 0;
    for (const c of collected) {
      data.set(c, o);
      o += c.length;
    }
    packets = collected.length;
  }

  const cswBytes = toBytes((await device.transferIn(eps.in, 13)).data);
  const csw = new DataView(cswBytes.buffer, cswBytes.byteOffset, cswBytes.byteLength);
  const result = {
    data,
    signature: csw.getUint32(0, true),
    tag: csw.getUint32(4, true),
    residue: csw.getUint32(8, true),
    status: csw.getUint8(12),
    expectedTag: myTag,
    packets,
  };
  tag++;
  return result;
}

/** Walk a configuration descriptor for the mass-storage interface. */
function findMassStorage(config) {
  let offset = 0;
  let current = null;
  while (offset + 1 < config.length) {
    const length = config[offset];
    const type = config[offset + 1];
    if (!length) break;
    if (type === 0x04) {
      const [, , number, , , cls, sub, proto] = config.subarray(offset, offset + 9);
      current =
        cls === 0x08 ? { interfaceNumber: number, subClass: sub, protocol: proto, in: null, out: null } : null;
    } else if (type === 0x05 && current) {
      const address = config[offset + 2];
      const attributes = config[offset + 3];
      if ((attributes & 0x03) === 0x02) {
        if (address & 0x80) current.in ??= address & 0x0f;
        else current.out ??= address & 0x0f;
      }
      if (current.in !== null && current.out !== null) return current;
    }
    offset += length;
  }
  return null;
}

// ---------------------------------------------------------------------------

console.log(`\nMass storage over USB/IP — busid ${busid}\n`);

const client = new UsbipClient(new WispTransport(wispUrl, target));
await client.connect();
const device = await client.importDevice(busid);
pass(`imported ${busid} (${device.vendorId.toString(16).padStart(4, '0')}:${device.productId.toString(16).padStart(4, '0')})`);

await device.selectConfiguration(1);
pass('SET_CONFIGURATION(1)');

// The device list reports no interfaces while unconfigured, so discover the
// endpoints from the configuration descriptor.
const head = await device.controlTransferIn(
  { requestType: 'standard', recipient: 'device', request: 0x06, value: 0x0200, index: 0 },
  9,
);
const totalLength = new DataView(toBytes(head.data).buffer, toBytes(head.data).byteOffset).getUint16(2, true);
const config = toBytes(
  (
    await device.controlTransferIn(
      { requestType: 'standard', recipient: 'device', request: 0x06, value: 0x0200, index: 0 },
      totalLength,
    )
  ).data,
);

const msc = findMassStorage(config);
check(Boolean(msc), 'located a mass-storage interface in the config descriptor');
if (!msc) {
  console.log('\n\x1b[31mNot a mass-storage device.\x1b[0m\n');
  await client.close();
  process.exit(1);
}
info(`interface ${msc.interfaceNumber}, subclass 0x${msc.subClass.toString(16)} (06 = SCSI), protocol 0x${msc.protocol.toString(16)} (50 = bulk-only)`);
info(`bulk IN ep ${msc.in}, bulk OUT ep ${msc.out}`);
check(msc.protocol === 0x50, 'bulk-only transport');

await device.claimInterface(msc.interfaceNumber);

// -- class-specific control IN: Get Max LUN ---------------------------------

console.log('\nclass-specific control transfer (Get Max LUN)');
// bmRequestType 0xA1: class | interface | device-to-host. Nothing else in
// this test suite exercises a class request with an IN data stage.
const maxLun = await device.controlTransferIn(
  { requestType: 'class', recipient: 'interface', request: 0xfe, value: 0, index: msc.interfaceNumber },
  1,
);
check(maxLun.data.byteLength === 1, `Get Max LUN returned ${toBytes(maxLun.data)[0]}`);

// -- SCSI over bulk ---------------------------------------------------------

console.log('\nSCSI INQUIRY over bulk (3-phase: CBW / data / CSW)');
const inquiry = await scsiIn(device, { in: msc.in, out: msc.out }, new Uint8Array([0x12, 0, 0, 0, 36, 0]), 36);
check(inquiry.signature === CSW_SIGNATURE, 'CSW signature is "USBS"');
check(inquiry.tag === inquiry.expectedTag, `CSW tag ${inquiry.tag} matches the CBW`);
check(inquiry.status === 0, 'CSW status: command passed');
check(inquiry.data.length === 36, `INQUIRY returned ${inquiry.data.length} bytes`);
// Assert on structure, not on the identity strings: the T10 vendor and
// product fields are frequently blank on consumer flash drives, so they are
// reported rather than required.
check(
  (inquiry.data[0] & 0x1f) === 0x00,
  'peripheral device type 0x00 (direct-access block device)',
);
check(inquiry.data[4] >= 31, `additional length ${inquiry.data[4]} covers the standard 36-byte page`);
const vendor = ascii(inquiry.data.subarray(8, 16));
const product = ascii(inquiry.data.subarray(16, 32));
const revision = ascii(inquiry.data.subarray(32, 36));
info(`identity: vendor ${JSON.stringify(vendor)} product ${JSON.stringify(product)} rev ${JSON.stringify(revision)}`);

console.log('\nSCSI READ CAPACITY (10)');
const capacity = await scsiIn(device, { in: msc.in, out: msc.out }, new Uint8Array([0x25, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 8);
check(capacity.status === 0, 'CSW status: command passed');
let blockSize = 512;
if (capacity.data.length === 8) {
  const cap = new DataView(capacity.data.buffer, capacity.data.byteOffset, capacity.data.byteLength);
  const lastLba = cap.getUint32(0, false); // SCSI is big-endian
  blockSize = cap.getUint32(4, false);
  const bytesTotal = (lastLba + 1) * blockSize;
  check(blockSize > 0, `${blockSize}-byte blocks, ${(bytesTotal / 1e9).toFixed(2)} GB`);
}

console.log('\nSCSI READ (10) of logical block 0');
const read = await scsiIn(
  device,
  { in: msc.in, out: msc.out },
  new Uint8Array([0x28, 0, 0, 0, 0, 0, 0, 0, 1, 0]), // READ(10), LBA 0, 1 block
  blockSize,
);
check(read.status === 0, 'CSW status: command passed');
check(read.data.length === blockSize, `read ${read.data.length} bytes in ${read.packets} bulk URB(s)`);
const signature = read.data.length >= 512 ? read.data.subarray(510, 512) : new Uint8Array(0);
if (signature.length === 2 && signature[0] === 0x55 && signature[1] === 0xaa) {
  pass('block 0 carries the 0x55AA boot signature (a real partition table)');
} else {
  info(`block 0 does not carry an MBR signature (${[...signature].map((b) => b.toString(16)).join(' ')}) — fine`);
}
info(`first 16 bytes: ${[...read.data.subarray(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);

await client.close();

console.log(
  failures === 0
    ? '\n\x1b[32mAll mass-storage checks passed — a class WebUSB will not touch.\x1b[0m\n'
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
