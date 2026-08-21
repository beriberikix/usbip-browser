# usbip-browser

A **USB/IP client that runs in the browser**. It speaks the USB/IP wire protocol to a stock
`usbipd`, giving JavaScript direct access to USB devices attached to a remote machine.

```ts
import { UsbipClient } from 'usbip-browser';
import { WispTransport } from 'usbip-browser/wisp';

const client = new UsbipClient(new WispTransport('wss://relay.example/', '192.168.1.10:3240'));
await client.connect();

const device = await client.importDevice('1-1');
await device.selectConfiguration(1);
const chunk = await device.transferIn(2, 64);
```

Framework-agnostic, TypeScript, **zero runtime dependencies**.

## Why this isn't WebUSB

WebUSB refuses to claim interfaces in protected classes — audio, **HID**, **mass storage**,
smartcard, **video**, wireless. It also needs a user-gesture device picker, udev rules on Linux,
and WinUSB on Windows.

None of that applies here, because **this library is not a USB host**. It is a protocol client:
the remote kernel does the USB work and we exchange URBs over TCP. A remote keyboard, webcam or
flash drive is just bytes on a socket. No picker, no udev rules, no blocklist.

The trade-off is that you need a `usbipd` on the machine with the hardware, and a bridge to reach
it from a browser.

## The bridge

Browsers cannot open TCP sockets, and USB/IP is raw TCP on port 3240. This library uses
[WISP](https://github.com/MercuryWorkshop/wisp-protocol), which tunnels TCP over WebSocket and
lets the *client* name `host:port` per stream — so a connect form can target any USB/IP server
at runtime.

Run any WISP server; pick by toolchain:

| Server | Language |
|---|---|
| [wisp-server-python](https://github.com/MercuryWorkshop/wisp-server-python) | Python |
| [wisp-js/server](https://github.com/MercuryWorkshop/wisp-js) | JavaScript |
| [epoxy-server](https://github.com/MercuryWorkshop/epoxy-tls) | Rust |
| [Woeful](https://github.com/MercuryWorkshop/Woeful) | C++ |
| [mrrowisp](https://github.com/soap-phia/mrrowisp) | Go |

> **An unrestricted WISP server is an open proxy.** Anything that can reach it can open TCP
> connections to anywhere it can reach. Put a host allowlist in front of any public deployment,
> and use the password-auth extension (supported below).

The client implements **WISP v2** with automatic **v1 fallback**, and negotiates the
stream-open-confirmation extension whenever a server offers it — worth having, because USB/IP
speaks first, so without it a wrong host looks like a hang rather than an error.

> **No WebSocket subprotocol is advertised by default.** The v2 spec says a
> `Sec-WebSocket-Protocol` header signals v2 support but never fixes a token, and
> wisp-server-python 0.9.0 fails the WebSocket handshake outright if *any* subprotocol is
> requested. Advertising none costs nothing — a server that doesn't send `INFO` first is handled
> by the v1 fallback — so it is the only interoperable default. Override with `subprotocols`
> if you have a server that requires one.

```ts
new WispTransport('wss://relay.example/', '192.168.1.10:3240', {
  auth: { username: 'ada', password: '…' },   // extension 0x02
  onMotd: (motd) => console.log(motd),        // extension 0x04
});
```

## Install

```sh
npm install usbip-browser
```

| Entry point | Contents |
|---|---|
| `usbip-browser` | `UsbipClient`, `UsbipDevice`, errors, transport interface |
| `usbip-browser/wisp` | `WispTransport` |
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

Then run a WISP server alongside it, and point the example at both.

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

**Mixed content:** an `https://` page cannot open a `ws://` socket, so the hosted demo needs
`wss://`. Local development over `http://localhost` has no such restriction.

## TLS

`wss://` encrypts the browser↔relay hop and is supported out of the box.

End-to-end TLS terminated in the browser — as [epoxy-tls](https://github.com/MercuryWorkshop/epoxy-tls)
provides — is deliberately **not** a dependency, for two reasons. It does not apply: `usbipd`
speaks plaintext on 3240, so there is no TLS listener to handshake with unless you front it with
`stunnel`. And it is **AGPL-3.0-only**, which would propagate to every application embedding this
library.

If you need it, implement `UsbipTransport` over epoxy in your own application — it is a small
interface, and the licence choice is then yours:

```ts
interface UsbipTransport {
  open(): Promise<void>;
  send(chunk: Uint8Array): Promise<void>;
  onData(handler: (chunk: Uint8Array) => void): void;
  onClose(handler: (cause?: Error) => void): void;
  close(): Promise<void>;
}
```

The same seam takes a Direct Sockets `TCPSocket` in an Isolated Web App, which removes the bridge
entirely.

## Not supported

- **Isochronous transfers.** The kernel's 1 ms cadence is not reachable through a JS event loop.
- **Acting as a USB/IP server** (exporting a local WebUSB device to a remote machine). WebUSB's
  parsed descriptor model drops class-specific descriptor bytes, so a remote kernel would see a
  subtly wrong device.

## Development

```sh
npm install
npm test          # 65 tests: codec, framing, WISP handshake, end-to-end
npm run typecheck
npm run build
```

The dependency-free constraint is enforced in CI, because every off-the-shelf WISP and TLS
implementation in this ecosystem is AGPL.

### Testing against a real WISP server, without USB hardware

`MockTransport` is the server half of USB/IP, so putting a socket around it gives a usable fake
`usbipd`. Combined with a real WISP server, this exercises the whole live path:

```sh
npm run build
node scripts/fake-usbipd.mjs                       # USB/IP on 127.0.0.1:3240

pip install git+https://github.com/MercuryWorkshop/wisp-server-python
python -m wisp.server --host 127.0.0.1 --port 6001 --allow-loopback

node scripts/live-check.mjs                        # headless assertions
cd examples/xterm && npm run dev                   # or drive it from the browser
```

`--allow-loopback` is required because the server refuses loopback and private addresses by
default — a sensible default worth preserving in any real deployment.

With real hardware bound, `scripts/hw-check.mjs` runs the same checks against a genuine
`usbipd`. It is read-only: it lists, imports, and reads descriptors over endpoint 0, never
writing to the device or touching bulk endpoints.

```sh
sudo modprobe usbip_host && sudo usbipd -D && sudo usbip bind -b 5-1
node scripts/hw-check.mjs 5-1
sudo usbip unbind -b 5-1        # afterwards
```

## Licence

Apache-2.0.
