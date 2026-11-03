#!/bin/sh
# Starts the API as the unprivileged node user, after making /data its own.
#
# /data is a bind mount from the host, and on a Synology a folder made in File
# Station belongs to the DSM account that made it, not to uid 1000. The API
# would replay its log and then fail on the first write. So the container
# starts as root only long enough to give /data to node, then drops to node
# for the app itself.
set -eu

if [ "$(id -u)" = "0" ]; then
  if [ -d /data ]; then
    # Only what is not already node's, so a large log is not rewritten on
    # every start. -h changes a symlink itself, never what it points at.
    find /data \( ! -user node -o ! -group node \) -exec chown -h node:node {} +
  fi
  exec su-exec node "$@"
fi

# Already unprivileged (someone set user: in compose): run as that user.
exec "$@"
