module usbip-browser/proxy

go 1.18

require (
    usbip-browser/cli latest
    usbip-browser/daemon latest
)

replace usbip-browser/cli => ../../cli
replace usbip-browser/daemon => ../../daemon
