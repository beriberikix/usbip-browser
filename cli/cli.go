package cli

import (
	"fmt"
	"os/exec"
)

// Version returns the version of the usbip tool
func Version() (string, error) {
	cmd := exec.Command("usbip", "version")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("failed to get version: %w", err)
	}
	return string(output), nil
}

// ListLocal lists the local USB devices
func ListLocal() (string, error) {
	cmd := exec.Command("usbip", "list", "--local")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("failed to list local devices: %w", err)
	}
	return string(output), nil
}

// ListRemote lists the remote USB devices on the specified server
func ListRemote(server string) (string, error) {
	cmd := exec.Command("usbip", "list", "--remote="+server)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("failed to list remote devices: %w", err)
	}
	return string(output), nil
}

// Attach attaches a remote USB device to the local machine
func Attach(server, busid string) (string, error) {
	cmd := exec.Command("usbip", "attach", "--remote="+server, "--busid="+busid)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("failed to attach device: %w", err)
	}
	return string(output), nil
}

// Port lists the USB ports currently in use
func Port() (string, error) {
	cmd := exec.Command("usbip", "port")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("failed to list ports: %w", err)
	}
	return string(output), nil
}

// Bind binds a USB device to the local machine
func Bind(busid string) (string, error) {
	cmd := exec.Command("usbip", "bind", "--busid="+busid)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("failed to bind device: %w", err)
	}
	return string(output), nil
}

// Unbind unbinds a USB device from the local machine
func Unbind(busid string) (string, error) {
	cmd := exec.Command("usbip", "unbind", "--busid="+busid)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("failed to unbind device: %w", err)
	}
	return string(output), nil
}

// Detach detaches a USB device from the local machine
func Detach(port string) (string, error) {
	cmd := exec.Command("usbip", "detach", "--port="+port)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("failed to detach device: %w", err)
	}
	return string(output), nil
}
