/**
 * xterm.js over USB/IP.
 *
 * Mock mode runs an emulated usbipd inside the page, so the hosted demo works
 * with no setup. Live mode talks to a real usbipd through a WISP relay.
 */
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import { UsbipClient, type UsbipTransport } from 'usbip-browser';
import { CdcAcmDevice } from 'usbip-browser/cdc-acm';
import { MockTransport } from 'usbip-browser/mock';
import { WispTransport } from 'usbip-browser/wisp';

const $ = <T extends HTMLElement>(id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const statusEl = $<HTMLParagraphElement>('status');
const motdEl = $<HTMLParagraphElement>('motd');
const connectBtn = $<HTMLButtonElement>('connect');
const disconnectBtn = $<HTMLButtonElement>('disconnect');
const relayInput = $<HTMLInputElement>('relay');
const targetInput = $<HTMLInputElement>('target');
const busidInput = $<HTMLInputElement>('busid');
const liveFields = document.querySelector<HTMLDivElement>('[data-live]')!;

function setStatus(message: string, state?: 'ok' | 'error'): void {
  statusEl.textContent = message;
  if (state) statusEl.dataset['state'] = state;
  else delete statusEl.dataset['state'];
}

function currentMode(): 'mock' | 'live' {
  const checked = document.querySelector<HTMLInputElement>('input[name="mode"]:checked');
  return checked?.value === 'live' ? 'live' : 'mock';
}

for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="mode"]')) {
  radio.addEventListener('change', () => {
    const live = currentMode() === 'live';
    liveFields.hidden = !live;
    setStatus(
      live
        ? 'Live mode needs a wss:// WISP relay reachable from this page.'
        : 'Ready. Mock mode needs no setup — just connect.',
    );
  });
}

// -- terminal ---------------------------------------------------------------

const term = new Terminal({
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 13,
  cursorBlink: true,
  convertEol: false,
  theme: { background: '#0a0c11', foreground: '#e6e8ee' },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open($('terminal'));
fit.fit();
window.addEventListener('resize', () => fit.fit());

term.writeln('\x1b[2mNot connected. Choose a source above and press Connect.\x1b[0m');

// -- session ----------------------------------------------------------------

interface Session {
  client: UsbipClient;
  port: CdcAcmDevice;
  disposeInput: () => void;
  pump: Promise<void>;
}

let session: Session | null = null;

function buildTransport(): { transport: UsbipTransport; busid: string } {
  if (currentMode() === 'mock') {
    // A little latency makes the emulation feel like real hardware.
    return { transport: new MockTransport({ latencyMs: 4 }), busid: '1-1' };
  }

  const relay = relayInput.value.trim();
  const target = targetInput.value.trim();
  const busid = busidInput.value.trim() || '1-1';
  if (!relay) throw new Error('Enter the WISP relay URL.');
  if (!target) throw new Error('Enter the usbipd host:port.');

  return {
    transport: new WispTransport(relay, target, {
      onMotd: (motd) => {
        motdEl.textContent = motd;
        motdEl.hidden = false;
      },
    }),
    busid,
  };
}

async function connect(): Promise<void> {
  connectBtn.disabled = true;
  motdEl.hidden = true;
  term.clear();

  try {
    const { transport, busid } = buildTransport();

    setStatus('Connecting…');
    const client = new UsbipClient(transport);
    await client.connect();

    setStatus(`Importing ${busid}…`);
    const device = await client.importDevice(busid);

    setStatus('Configuring CDC-ACM…');
    const port = await CdcAcmDevice.open(device, { baudRate: 115200 });

    const vid = device.vendorId.toString(16).padStart(4, '0');
    const pid = device.productId.toString(16).padStart(4, '0');
    setStatus(`Connected — ${device.busid} ${vid}:${pid} (${device.info.speed} speed)`, 'ok');

    // Device -> terminal.
    const decoder = new TextDecoder();
    const pump = (async () => {
      const reader = port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          term.write(decoder.decode(value, { stream: true }));
        }
      } catch (error) {
        if (session) term.writeln(`\r\n\x1b[31m${(error as Error).message}\x1b[0m`);
      } finally {
        reader.releaseLock();
      }
    })();

    // Terminal -> device.
    const writer = port.writable.getWriter();
    const encoder = new TextEncoder();
    const listener = term.onData((data) => {
      void writer.write(encoder.encode(data)).catch((error: Error) => {
        setStatus(`Write failed: ${error.message}`, 'error');
      });
    });

    session = {
      client,
      port,
      pump,
      disposeInput: () => {
        listener.dispose();
        writer.releaseLock();
      },
    };

    connectBtn.hidden = true;
    disconnectBtn.hidden = false;
    term.focus();
  } catch (error) {
    setStatus((error as Error).message, 'error');
    term.writeln(`\x1b[31m${(error as Error).message}\x1b[0m`);
  } finally {
    connectBtn.disabled = false;
  }
}

async function disconnect(): Promise<void> {
  const active = session;
  session = null;
  if (!active) return;

  disconnectBtn.disabled = true;
  try {
    active.disposeInput();
    await active.port.close();
    await active.client.close();
    await active.pump;
  } catch {
    // Tearing down; failures here are not actionable.
  } finally {
    disconnectBtn.disabled = false;
    disconnectBtn.hidden = true;
    connectBtn.hidden = false;
    setStatus('Disconnected.');
    term.writeln('\r\n\x1b[2mDisconnected.\x1b[0m');
  }
}

connectBtn.addEventListener('click', () => void connect());
disconnectBtn.addEventListener('click', () => void disconnect());
