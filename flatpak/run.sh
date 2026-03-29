#!/bin/sh

export TMPDIR="${XDG_RUNTIME_DIR}/app/${FLATPAK_ID}"

if [ "${XDG_SESSION_TYPE}" = "wayland" ]; then
  set -- --ozone-platform-hint=auto "$@"
fi

exec zypak-wrapper /app/lib/freetube-plus-tabs/freetube-plus-tabs "$@"
