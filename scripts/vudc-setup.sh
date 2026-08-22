#!/usr/bin/env bash
#
# ############################################################################
# #  DANGER: this hard-froze a Linux 7.0 workstation twice, needing a power  #
# #  cycle both times. Do NOT run it on a machine you care about.            #
# ############################################################################
#
# Build a virtual USB gadget and export it over USB/IP.
#
# usbip-vudc is a virtual USB device controller: the kernel synthesises a USB
# device in software and usbipd exports it, so device classes can be tested
# without physical hardware. That is genuinely useful -- it is the only way to
# get a real CDC-ACM device or interrupt endpoints without buying hardware --
# but the driver proved fragile under a USB/IP client that is not the kernel's
# own vhci. Attaching, detaching abruptly, and reattaching wedged it hard
# enough to take the whole machine down, with nothing in the logs.
#
# The gadget's far side appears locally as a character device (/dev/ttyGS0 for
# ACM, /dev/hidg0 for HID), which is what would make these tests deterministic:
# the exact bytes the device sends, and when, are chosen by the test.
#
# ONLY run this inside a throwaway VM, where a kernel hang costs you the VM
# rather than your session. Pass --in-vm to acknowledge that.
#
#   sudo scripts/vudc-setup.sh acm --in-vm
#   sudo scripts/vudc-setup.sh hid --in-vm
#   sudo scripts/vudc-teardown.sh
#
set -euo pipefail

ACKNOWLEDGED=0
ARGS=()
for arg in "$@"; do
  if [ "$arg" = "--in-vm" ]; then ACKNOWLEDGED=1; else ARGS+=("$arg"); fi
done
set -- "${ARGS[@]+"${ARGS[@]}"}"

if [ "$ACKNOWLEDGED" != "1" ]; then
  cat >&2 <<'WARNING'
REFUSING TO RUN.

usbip-vudc hard-froze a Linux 7.0 workstation twice during this project's
testing, requiring a power cycle each time. No oops, no log entry -- the
machine simply stopped.

It is still the only practical way to test CDC-ACM and interrupt endpoints
without physical hardware, so this script is kept. Run it only inside a
throwaway VM, and pass --in-vm to confirm that is where you are.
WARNING
  exit 1
fi

FUNC="${1:-acm}"
GADGET=/sys/kernel/config/usb_gadget/usbipbrowser
UDC_NAME=usbip-vudc.0

if [ "$(id -u)" != "0" ]; then
  echo "must run as root" >&2
  exit 1
fi

case "$FUNC" in
  acm|hid) ;;
  *) echo "usage: $0 [acm|hid]" >&2; exit 1 ;;
esac

echo "==> loading modules"
modprobe libcomposite
modprobe usbip-vudc
[ "$FUNC" = acm ] && modprobe usb_f_acm || modprobe usb_f_hid

if [ ! -e "/sys/class/udc/$UDC_NAME" ]; then
  echo "no $UDC_NAME under /sys/class/udc; available:" >&2
  ls /sys/class/udc 2>/dev/null >&2 || echo "  (none)" >&2
  exit 1
fi
echo "    UDC present: $UDC_NAME"

# Remove any previous gadget so this script is re-runnable.
if [ -d "$GADGET" ]; then
  echo "==> removing previous gadget"
  echo "" > "$GADGET/UDC" 2>/dev/null || true
  find "$GADGET/configs" -maxdepth 2 -type l -delete 2>/dev/null || true
  rmdir "$GADGET"/configs/*/strings/0x409 2>/dev/null || true
  rmdir "$GADGET"/configs/* 2>/dev/null || true
  rmdir "$GADGET"/functions/* 2>/dev/null || true
  rmdir "$GADGET"/strings/0x409 2>/dev/null || true
  rmdir "$GADGET" 2>/dev/null || true
fi

echo "==> creating gadget ($FUNC)"
mkdir -p "$GADGET"
cd "$GADGET"

# 1d6b:0104 is the Linux Foundation multifunction composite gadget, the
# conventional id for a software-defined device like this.
echo 0x1d6b > idVendor
echo 0x0104 > idProduct
echo 0x0200 > bcdUSB
echo 0x0100 > bcdDevice

mkdir -p strings/0x409
echo "usbip-browser" > strings/0x409/manufacturer
echo "Virtual $(echo "$FUNC" | tr '[:lower:]' '[:upper:]') Gadget" > strings/0x409/product
echo "0123456789" > strings/0x409/serialnumber

mkdir -p configs/c.1/strings/0x409
echo "Config 1" > configs/c.1/strings/0x409/configuration
echo 120 > configs/c.1/MaxPower

if [ "$FUNC" = acm ]; then
  mkdir -p functions/acm.usb0
  ln -s functions/acm.usb0 configs/c.1/
else
  mkdir -p functions/hid.usb0
  echo 1 > functions/hid.usb0/protocol   # keyboard
  echo 1 > functions/hid.usb0/subclass   # boot interface
  echo 8 > functions/hid.usb0/report_length
  # Standard 63-byte boot-keyboard report descriptor.
  printf '\x05\x01\x09\x06\xa1\x01\x05\x07\x19\xe0\x29\xe7\x15\x00\x25\x01\x75\x01\x95\x08\x81\x02\x95\x01\x75\x08\x81\x03\x95\x05\x75\x01\x05\x08\x19\x01\x29\x05\x91\x02\x95\x01\x75\x03\x91\x03\x95\x06\x75\x08\x15\x00\x25\x65\x05\x07\x19\x00\x29\x65\x81\x00\xc0' \
    > functions/hid.usb0/report_desc
  ln -s functions/hid.usb0 configs/c.1/
fi

echo "==> binding to $UDC_NAME"
echo "$UDC_NAME" > UDC
sleep 0.5

# Let the unprivileged test scripts drive the gadget side.
if [ "$FUNC" = acm ]; then
  [ -e /dev/ttyGS0 ] && chmod 666 /dev/ttyGS0 && echo "    /dev/ttyGS0 ready"
else
  [ -e /dev/hidg0 ] && chmod 666 /dev/hidg0 && echo "    /dev/hidg0 ready"
fi

echo "==> starting usbipd in device mode"
pkill usbipd 2>/dev/null || true
sleep 0.3
usbipd -D -e
sleep 1

echo "==> exported gadgets"
usbip list -d || true
echo
echo "Done. The busid to import is shown above (typically usbip-vudc.0)."
