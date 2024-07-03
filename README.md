# usbip-browser

This repository contains a monorepo for managing USB over IP using the `usbip` command-line tool and the `usbipd` daemon. It includes modules for handling `usbip` commands (`cli`) and managing the `usbipd` daemon (`daemon`). The proxy application provides HTTP endpoints for these functionalities.

## Directory Structure

```
usbip-browser/
├── cli/
│   ├── cli.go
│   ├── go.mod
├── daemon/
│   ├── daemon.go
│   ├── go.mod
├── cmd/
│   ├── proxy/
│   │   ├── main.go
│   │   ├── go.mod
│   │   ├── README.md
├── client/
│   ├── src/
│   │   ├── index.ts
│   ├── package.json
│   ├── tsconfig.json
│   ├── README.md
├── README.md
```

## Setting Up

1. **Clone the repository:**

   ```sh
   git clone https://github.com/<your-username>/usbip-browser.git
   cd usbip-browser
   ```

2. **Initialize and tidy Go modules:**

   ```sh
   go mod tidy
   cd cli
   go mod tidy
   cd ../daemon
   go mod tidy
   cd ../cmd/proxy
   go mod tidy
   cd ../../..
   ```

3. **Run the proxy application:**

   ```sh
   cd cmd/proxy
   go run main.go
   ```

   You should see the output:

   ```
   Server started at :8080
   ```

   This means your HTTP server is up and running on port 8080.

## HTTP Endpoints

You can use `curl` or any HTTP client to interact with the endpoints.

1. **Check USBIP Version**

   ```sh
   curl http://localhost:8080/usbip/version
   ```

2. **List Local USB Devices**

   ```sh
   curl http://localhost:8080/usbip/list/local
   ```

3. **List Remote USB Devices**

   ```sh
   curl "http://localhost:8080/usbip/list/remote?server=your_server_address"
   ```

4. **Attach a Remote USB Device**

   ```sh
   curl "http://localhost:8080/usbip/attach?server=your_server_address&busid=your_bus_id"
   ```

5. **List USB Ports**

   ```sh
   curl http://localhost:8080/usbip/port
   ```

6. **Bind a USB Device**

   ```sh
   curl "http://localhost:8080/usbip/bind?busid=your_bus_id"
   ```

7. **Unbind a USB Device**

   ```sh
   curl "http://localhost:8080/usbip/unbind?busid=your_bus_id"
   ```

8. **Detach a USB Device**

   ```sh
   curl "http://localhost:8080/usbip/detach?port=your_port"
   ```

9. **Start the `usbipd` Daemon**

   ```sh
   curl http://localhost:8080/usbipd/start
   ```

10. **Stop the `usbipd` Daemon**

    ```sh
    curl http://localhost:8080/usbipd/stop
    ```

11. **Check the Status of the `usbipd` Daemon**

    ```sh
    curl http://localhost:8080/usbipd/status
    ```

## Contribution

Feel free to open issues or submit pull requests for any improvements or bug fixes.

## License

This project is licensed under the Apache 2.
