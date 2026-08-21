/**
 * A TCP server that speaks USB/IP, for testing the live path without hardware.
 *
 * MockTransport already implements the server half of the protocol; all this
 * adds is a socket. Each connection gets its own instance, so the emulated
 * device has per-client shell state, exactly as a real device would not --
 * but that distinction does not matter for protocol testing.
 *
 *   node scripts/fake-usbipd.mjs [port]
 *
 * Requires `npm run build` first.
 */
import net from 'node:net';
import { MockTransport } from '../dist/mock.js';

const port = Number(process.argv[2] ?? 3240);

const server = net.createServer((socket) => {
  const peer = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`[fake-usbipd] connect ${peer}`);

  const transport = new MockTransport();
  transport.onData((chunk) => {
    if (!socket.destroyed) socket.write(chunk);
  });
  transport.onClose(() => socket.end());

  socket.on('data', (chunk) => {
    void transport.send(new Uint8Array(chunk)).catch((error) => {
      console.error(`[fake-usbipd] ${peer} send failed:`, error.message);
    });
  });
  socket.on('close', () => {
    console.log(`[fake-usbipd] disconnect ${peer}`);
    void transport.close();
  });
  socket.on('error', (error) => {
    console.error(`[fake-usbipd] ${peer} socket error: ${error.message}`);
  });

  void transport.open();
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[fake-usbipd] listening on 127.0.0.1:${port} (busid 1-1)`);
});
