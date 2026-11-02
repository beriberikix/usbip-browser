# usbip-browser

A **USB/IP client that runs in the browser**. It speaks the USB/IP wire protocol to a stock
`usbipd`, giving JavaScript direct access to USB devices attached to a remote machine.

```ts
import { UsbipClient } from 'usbip-browser';
import { RelaynetTransport } from 'usbip-browser/relaynet';

// 10.0.2.15 is the address relaynet-bridge logged on the machine running usbipd.
const client = new UsbipClient(new RelaynetTransport('10.0.2.15:3240', { token }));
await client.connect();

const device = await client.importDevice('1-1');
await device.selectConfiguration(1);
const chunk = await device.transferIn(2, 64);
```

Framework-agnostic, TypeScript. Runtime dependencies are permissively licensed only, which CI
enforces: [tcpip.js](https://github.com/chipmk/tcpip.js) (lwIP compiled to WebAssembly) and
relaynet's client helper, both MIT.

## Why this isn't WebUSB

WebUSB refuses to claim interfaces in protected classes — audio, **HID**, **mass storage**,
smartcard, **video**, wireless. It also needs a user-gesture device picker, udev rules on Linux,
and WinUSB on Windows.

None of that applies here, because **this library is not a USB host**. It is a protocol client:
the remote kernel does the USB work and we exchange URBs over TCP. A remote keyboard, webcam or
flash drive is just bytes on a socket. No picker, no udev rules, no blocklist.

This is demonstrated rather than asserted. `scripts/msc-check.mjs` reads a partition table off a
USB flash drive — interface class `0x08`, which Chrome refuses to let WebUSB claim at all:

```
class-specific control transfer (Get Max LUN)
  ✓ Get Max LUN returned 0
SCSI INQUIRY over bulk (3-phase: CBW / data / CSW)
  ✓ CSW status: command passed
SCSI READ (10) of logical block 0
  ✓ block 0 carries the 0x55AA boot signature (a real partition table)
```

The trade-off is that you need a `usbipd` on the machine with the hardware, and a bridge to reach
it from a browser.

## The bridge: relaynet

Browsers cannot open TCP sockets, and USB/IP is raw TCP on port 3240. This library reaches a
`usbipd` through [relaynet](https://relaynet.network), which carries Ethernet frames over a
WebSocket and gives the sessions of one account a private network. On the machine with the
hardware, next to `usbipd`, run
[relaynet-bridge](https://github.com/beriberikix/relaynet-bridge):

```sh
export RELAYNET_TOKEN=rr_...
relaynet-bridge -expose 3240
# level=INFO msg=joined addr=10.0.2.15 expose="10.0.2.15:3240 -> 127.0.0.1:3240"
```

and connect the page to the address it logs. The bridge connects out to the relay like any other
session, so **nothing listens on the internet** and no inbound port is opened: no proxy of your
own to host, secure or keep from becoming an open relay.

```
UsbipClient -> RelaynetTransport -> tcpip.js (TCP <-> Ethernet frames)
  -> relaynet helper (WebSocket, relay.v1) -> relaynet -> relaynet-bridge -> usbipd
```

A page has no TCP/IP stack, so the transport brings one: lwIP, compiled to WebAssembly by
tcpip.js (about 94 KB, 36 KB gzipped). It leases an address over DHCP, which matters: relaynet
routes between sessions by lease, so a session on a static address never hears back from the
bridge.

What to know:

- **It needs a relaynet beta account.** Only a beta account's sessions share a network; demo
  tokens and free accounts cannot reach a bridge. An account holds four sessions and the bridge
  uses one, and each imported device is a session of its own.
- **Or run the relay yourself.** relaynet is a hosted
  [rootlessRelay](https://github.com/obegron/rootlessRelay), which speaks the same protocol; pass
  its URL, with no token if it runs without authentication:
  `new RelaynetTransport(target, { url: 'ws://127.0.0.1:8086/' })`.
- **Every transfer is a round trip through the relay** (tens to a couple of hundred
  milliseconds, 1 MiB/s per session). Serial adapters, debug probes and security keys are fine;
  mass storage works but slowly; video and audio do not fit.
- **A dropped session recovers.** relaynet's helper reconnects, and the transport runs DHCP again
  with the same MAC; relaynet holds the address for 60 s, so the TCP connection to the bridge
  carries on. If the address does not come back, the transport closes with a `RelaynetError`.

```ts
new RelaynetTransport('10.0.2.15:3240', {
  token,                                     // a beta account's API token
  onStatus: (line) => console.log(line),     // session dropped / restored
  timeoutMs: 20_000,                         // relay + DHCP + TCP connect
});
```

## Install

```sh
npm install usbip-browser
```

| Entry point | Contents |
|---|---|
| `usbip-browser` | `UsbipClient`, `UsbipDevice`, errors, transport interface |
| `usbip-browser/relaynet` | `RelaynetTransport` — USB/IP through relaynet |
| `usbip-browser/cdc-acm` | `CdcAcmDevice` — serial ports as Web Streams |
| `usbip-browser/mock` | `MockTransport` — an emulated usbipd, for demos and tests |

## Serial (CDC-ACM)

`CdcAcmDevice` handles `SET_CONFIGURATION` → `SET_LINE_CODING` → `SET_CONTROL_LINE_STATE`
and exposes the bulk endpoints as standard streams:

```ts
import { CdcAcmDevice } from 'usbip-browser/cdc-acm';

const port = await CdcAcmDevice.open(device, { baudRate: 115200 });
const writer = port.writable.getWriter();
await writer.write(new TextEncoder().encode('help\r'));

const reader = port.readable.getReader();
const { value } = await reader.read();
```

## Example

[`examples/xterm`](examples/xterm) wires that to xterm.js. It defaults to an in-browser mock
device, so it works with no setup at all:

```sh
cd examples/xterm && npm install && npm run dev
```

The mock is not a stub — it encodes and decodes the same wire format through the same codec as
the network path, so a parser bug fails there too.

## Using it against real hardware

On the machine with the USB device:

```sh
sudo modprobe usbip_host
sudo usbipd -D
usbip list -l                  # find the busid
sudo usbip bind -b 1-1         # detaches the kernel driver
```

Then run `relaynet-bridge -expose 3240` alongside it, and give the example (Live mode) your token
and the address the bridge logs.

> **A freshly bound device arrives unconfigured.** `usbip bind` detaches the kernel driver and
> leaves the device in the address state, so `OP_REP_DEVLIST` reports
> `bConfigurationValue = 0`, `bNumInterfaces = 0`, and an empty `interfaces` array — verified
> against usbipd 2.0 with an FTDI FT4232H. Two consequences:
>
> - **You must call `selectConfiguration`** before any interface or endpoint work. `0` is not a
>   selectable configuration; `SET_CONFIGURATION(0)` *unconfigures* a device. `CdcAcmDevice`
>   defaults to `1` when the device reports none.
> - **Do not use `info.interfaces` to discover interfaces.** It is empty while unconfigured.
>   Read the configuration descriptor over endpoint 0 instead — `scripts/hw-check.mjs` shows the
>   two-stage read.

## Encryption

The page's hop to relaynet is `wss://`, and so is the bridge's. Between them, USB/IP is plaintext
TCP, as it is on any network: `usbipd` has no TLS. The relay carries it as plain IP between your
own sessions, so if the relay operator must not see your URBs, run rootlessRelay yourself.

Other ways to reach port 3240 fit the same small seam, `UsbipTransport`:

```ts
interface UsbipTransport {
  open(): Promise<void>;
  send(chunk: Uint8Array): Promise<void>;
  onData(handler: (chunk: Uint8Array) => void): void;
  onClose(handler: (cause?: Error) => void): void;
  close(): Promise<void>;
}
```

A Direct Sockets `TCPSocket` in an Isolated Web App, for instance, removes the relay entirely.

## Known-unverified

Two paths are implemented and unit-tested, but have never run against a real kernel:

- **`CdcAcmDevice` against genuine CDC-ACM hardware.** The class requests (`SET_LINE_CODING`,
  `SET_CONTROL_LINE_STATE`) and the read stream are covered by tests that replay behaviour
  observed on real hardware — including the zero-length-completion interleaving that once stalled
  the stream — but the hardware checks drive `transferIn` directly rather than through
  `CdcAcmDevice`. A real CDC-ACM device (an ESP32-C3's native USB, a Pi Pico, an Arduino
  Leonardo) would close this.
- **Interrupt endpoints.** Supported in the same code path as bulk, and differing only in
  scheduling, but never exercised against a kernel.

> **`usbip-vudc` is not a safe way to close these gaps.** It is the obvious approach — the kernel
> synthesises a CDC-ACM or HID gadget and exports it, no hardware needed — and
> `scripts/vudc-setup.sh` implements it. But driving it from a USB/IP client that is not the
> kernel's own `vhci` **hard-froze a Linux 7.0 workstation twice**, requiring a power cycle, with
> nothing in the logs. The script therefore refuses to run without `--in-vm`. Use a throwaway VM,
> where a kernel hang costs you the VM instead of your session.

## Not supported

- **Isochronous transfers.** The kernel's 1 ms cadence is not reachable through a JS event loop.
- **Acting as a USB/IP server** (exporting a local WebUSB device to a remote machine). WebUSB's
  parsed descriptor model drops class-specific descriptor bytes, so a remote kernel would see a
  subtly wrong device.

## Development

```sh
npm install
npm test          # 85 tests: codec, framing, DHCP, the relaynet transport, end-to-end
npm run typecheck
npm run build
```

`scripts/check-licenses.mjs`, which CI runs, fails on any runtime dependency, direct or
transitive, that is not permissively licensed: this library is embedded in other applications,
and a copyleft dependency would pass its terms on to them.

The relaynet tests run against an in-process relay (`test/support/fake-relay.ts`) that answers
DHCP and routes by lease as relaynet does; relaynet's real helper, both lwIP stacks and the USB/IP
codec are the real ones, so a dropped session and its recovery are tested without a network.

### Testing through relaynet, without USB hardware

`MockTransport` is the server half of USB/IP, so putting a socket around it gives a usable fake
`usbipd`. Behind relaynet-bridge, this exercises the whole live path through the real relay:

```sh
npm run build
node scripts/fake-usbipd.mjs                       # USB/IP on 127.0.0.1:3240
relaynet-bridge -expose 3240                       # note the address it logs

export RELAYNET_TOKEN=rr_...                       # or RELAYNET_TOKEN_FILE
node scripts/live-check.mjs 10.0.2.15:3240         # headless assertions
cd examples/xterm && npm run dev                   # or Live mode in the browser
```

With real hardware bound, `scripts/hw-check.mjs <busid> <bridge address:3240>` runs the same
checks against a genuine `usbipd`. It is read-only: it lists, imports, and reads descriptors over endpoint 0, never
writing to the device or touching bulk endpoints.

```sh
sudo modprobe usbip_host && sudo usbipd -D && sudo usbip bind -b <busid>
node scripts/hw-check.mjs <busid>
sudo usbip unbind -b <busid>    # afterwards
```

Three hardware scripts, each covering a different part of the surface. All are read-only except
where noted:

| Script | Device used to verify it | Covers |
|---|---|---|
| `hw-check.mjs` | FTDI FT4232H | Standard control IN: device, configuration, and string descriptors |
| `cp210x-bulk-check.mjs` | CP2102N + ESP32-C3 | Vendor control transfers, bulk IN/OUT, `CMD_UNLINK`. *Resets the ESP32.* |
| `msc-check.mjs` | USB flash drive | Class-specific control IN, three-phase SCSI over bulk |

Unmount a storage device before binding it — `usbip bind` detaches it from `usb-storage` while
the kernel still believes it is mounted.

## Licence

Apache-2.0.
