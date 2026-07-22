#!/bin/sh
# Debian postinst. Runs as root after files are unpacked.
set -e

case "$1" in
  configure)
    # Load the serial rules now so a board that is already plugged in — or one
    # plugged in before the next reboot — picks up the uaccess ACL. Without the
    # reload, udev keeps using its cached rule set and Upload fails with a
    # permission error until the user reboots.
    if command -v udevadm > /dev/null 2>&1; then
      udevadm control --reload-rules > /dev/null 2>&1 || true
      udevadm trigger --subsystem-match=tty > /dev/null 2>&1 || true
    fi
    ;;
esac

exit 0
