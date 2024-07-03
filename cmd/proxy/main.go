package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"usbip-browser/cli"
	"usbip-browser/daemon"
)

func main() {
	http.HandleFunc("/version", handleVersion)
	http.HandleFunc("/list/local", handleListLocal)
	http.HandleFunc("/list/remote", handleListRemote)
	http.HandleFunc("/attach", handleAttach)
	http.HandleFunc("/port", handlePort)
	http.HandleFunc("/bind", handleBind)
	http.HandleFunc("/unbind", handleUnbind)
	http.HandleFunc("/detach", handleDetach)
	http.HandleFunc("/start", handleStartDaemon)
	http.HandleFunc("/stop", handleStopDaemon)
	http.HandleFunc("/status", handleDaemonStatus)

	fmt.Println("Server started at :8080")
	http.ListenAndServe(":8080", nil)
}

func handleVersion(w http.ResponseWriter, r *http.Request) {
	output, err := cli.Version()
	respond(w, output, err)
}

func handleListLocal(w http.ResponseWriter, r *http.Request) {
	output, err := cli.ListLocal()
	respond(w, output, err)
}

func handleListRemote(w http.ResponseWriter, r *http.Request) {
	server := r.URL.Query().Get("server")
	output, err := cli.ListRemote(server)
	respond(w, output, err)
}

func handleAttach(w http.ResponseWriter, r *http.Request) {
	server := r.URL.Query().Get("server")
	busid := r.URL.Query().Get("busid")
	output, err := cli.Attach(server, busid)
	respond(w, output, err)
}

func handlePort(w http.ResponseWriter, r *http.Request) {
	output, err := cli.Port()
	respond(w, output, err)
}

func handleBind(w http.ResponseWriter, r *http.Request) {
	busid := r.URL.Query().Get("busid")
	output, err := cli.Bind(busid)
	respond(w, output, err)
}

func handleUnbind(w http.ResponseWriter, r *http.Request) {
	busid := r.URL.Query().Get("busid")
	output, err := cli.Unbind(busid)
	respond(w, output, err)
}

func handleDetach(w http.ResponseWriter, r *http.Request) {
	port := r.URL.Query().Get("port")
	output, err := cli.Detach(port)
	respond(w, output, err)
}

func handleStartDaemon(w http.ResponseWriter, r *http.Request) {
	err := daemon.StartDaemon()
	respond(w, "usbipd daemon started", err)
}

func handleStopDaemon(w http.ResponseWriter, r *http.Request) {
	err := daemon.StopDaemon()
	respond(w, "usbipd daemon stopped", err)
}

func handleDaemonStatus(w http.ResponseWriter, r *http.Request) {
	running := daemon.IsDaemonRunning()
	status := "usbipd daemon is not running"
	if running {
		status = "usbipd daemon is running"
	}
	respond(w, status, nil)
}

func respond(w http.ResponseWriter, output string, err error) {
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"output": output})
}
