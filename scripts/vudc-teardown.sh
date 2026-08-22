#!/usr/bin/env bash
#
# Remove the virtual gadget created by vudc-setup.sh and stop usbipd.
#
#   sudo scripts/vudc-teardown.sh
#
set -uo pipefail

GADGET=/sys/kernel/config/usb_gadget/usbipbrowser

if [ "$(id -u)" != "0" ]; then
  echo "must run as root" >&2
  exit 1
fi

echo "==> stopping usbipd"
pkill usbipd 2>/dev/null || true

if [ -d "$GADGET" ]; then
  echo "==> unbinding and removing gadget"
  echo "" > "$GADGET/UDC" 2>/dev/null || true
  find "$GADGET/configs" -maxdepth 2 -type l -delete 2>/dev/null || true
  rmdir "$GADGET"/configs/*/strings/0x409 2>/dev/null || true
  rmdir "$GADGET"/configs/* 2>/dev/null || true
  rmdir "$GADGET"/functions/* 2>/dev/null || true
  rmdir "$GADGET"/strings/0x409 2>/dev/null || true
  rmdir "$GADGET" 2>/dev/null || true
fi

echo "==> unloading modules"
modprobe -r usb_f_acm usb_f_hid 2>/dev/null || true
modprobe -r usbip-vudc 2>/dev/null || true

echo "Done."
