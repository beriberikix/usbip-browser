# usbip-browser Client

This directory contains the client-side code for interacting with the usbip-browser proxy application. The client is implemented in TypeScript and communicates with the proxy server via HTTP endpoints.

## Directory Structure

```
client/
├── src/
│   ├── index.ts
├── package.json
├── tsconfig.json
├── README.md
```

## Setting Up

1. **Install dependencies:**

   ```sh
   npm install
   ```

2. **Build the client:**

   ```sh
   npm run build
   ```

3. **Run the client:**

   ```sh
   npm start
   ```

## Interacting with the Proxy Server

The client communicates with the proxy server running at `http://localhost:8080`. Make sure the proxy server is running before using the client.

## HTTP Endpoints

The client uses the following HTTP endpoints:

1. **Check USBIP Version**

   ```sh
   GET /usbip/version
   ```

2. **List Local USB Devices**

   ```sh
   GET /usbip/list/local
   ```

3. **List Remote USB Devices**

   ```sh
   GET /usbip/list/remote?server=your_server_address
   ```

4. **Attach a Remote USB Device**

   ```sh
   GET /usbip/attach?server=your_server_address&busid=your_bus_id
   ```

5. **List USB Ports**

   ```sh
   GET /usbip/port
   ```

6. **Bind a USB Device**

   ```sh
   GET /usbip/bind?busid=your_bus_id
   ```

7. **Unbind a USB Device**

   ```sh
   GET /usbip/unbind?busid=your_bus_id
   ```

8. **Detach a USB Device**

   ```sh
   GET /usbip/detach?port=your_port
   ```

9. **Start the `usbipd` Daemon**

   ```sh
   GET /usbipd/start
   ```

10. **Stop the `usbipd` Daemon**

    ```sh
    GET /usbipd/stop
    ```

11. **Check the Status of the `usbipd` Daemon**

    ```sh
    GET /usbipd/status
    ```

## Contribution

Feel free to open issues or submit pull requests for any improvements or bug fixes.

## License

This project is licensed under the Apache 2.
