#!/bin/sh
# Hmelj container entrypoint.
#
# Everything Hmelj persists lives in $DATA_DIR (/data). A NAMED docker volume is
# seeded from the image, ownership included, so it just works. A BIND mount is
# not: it replaces the image's /data wholesale and keeps the HOST directory's
# ownership — almost always root — while the app runs unprivileged. That used to
# stop the container dead on first start with "unable to open database file",
# and the fix was an undocumented chown on the host.
#
# So: if we start as root, take ownership of the data directory and then drop to
# an unprivileged user before exec'ing the app. Root exists only for the chown;
# no application code ever runs as root.
#
# PUID/PGID override which user that is, for NAS setups that want the files to
# belong to a specific account. Defaults to 1000:1000, which is the `node` user
# baked into the image.
#
# If the container was started with an explicit --user (so we are NOT root),
# nothing is adjusted — the operator has said what they want, and we could not
# chown anyway. The app's own startup check explains the failure in that case.
set -e

DATA_DIR="${DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  PUID="${PUID:-1000}"
  PGID="${PGID:-1000}"

  mkdir -p "$DATA_DIR"

  # Only when it is actually wrong: a recursive chown over a large message cache
  # on every single start would cost seconds for nothing.
  cur_uid="$(stat -c %u "$DATA_DIR" 2>/dev/null || echo -1)"
  cur_gid="$(stat -c %g "$DATA_DIR" 2>/dev/null || echo -1)"
  if [ "$cur_uid" != "$PUID" ] || [ "$cur_gid" != "$PGID" ]; then
    echo "[entrypoint] $DATA_DIR is owned by $cur_uid:$cur_gid — taking ownership as $PUID:$PGID"
    # Not fatal: a read-only mount is a legitimate (if unusual) choice, and the
    # app reports what it cannot write far more clearly than chown does.
    chown -R "$PUID:$PGID" "$DATA_DIR" || \
      echo "[entrypoint] WARNING: could not chown $DATA_DIR — continuing; Hmelj will report if it cannot write"
  fi

  exec su-exec "$PUID:$PGID" "$@"
fi

# Already unprivileged (explicit --user, or a runtime that forbids root).
exec "$@"
