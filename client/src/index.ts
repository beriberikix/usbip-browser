async function connectToUsbDevice() {
  try {
    const device = await navigator.usb.requestDevice({ filters: [] });
    await device.open();
    await device.selectConfiguration(1);
    await device.claimInterface(0);
    console.log('Device connected:', device);
    return device;
  } catch (error) {
    console.error('Error connecting to USB device:', error);
  }
}

const socket = new WebSocket('ws://your-server-address');

socket.onopen = () => {
  console.log('WebSocket connection opened');
};

socket.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('Received data from server:', data);
  // Handle USB responses from the server
};

socket.onclose = () => {
  console.log('WebSocket connection closed');
};

socket.onerror = (error) => {
  console.error('WebSocket error:', error);
};

function sendUsbRequestToServer(request: any) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(request));
  }
}
