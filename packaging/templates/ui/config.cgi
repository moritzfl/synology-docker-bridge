#!/bin/sh
# The app's settings file, for administrators: read it, save it (the bridge checks it first and
# restores it if the app does not start with it), and follow the restart that applies it.
cd "$(dirname "$0")" || exit 1
. ./auth.sh

VAR="${SYNOPKG_PKGVAR:-/var/packages/{{id}}/var}"
input="$VAR/config.$$.in"
output="$VAR/config.$$.out"
trap 'rm -f "$input" "$output"' EXIT

if [ "${REQUEST_METHOD:-GET}" = POST ]; then
  length="${CONTENT_LENGTH:-0}"
  case "$length" in
    ''|*[!0-9]*) json_error 400 length ;;
  esac
  if [ "$length" -gt 1048576 ]; then
    head -c "$length" >/dev/null
    json_error 413 size
  fi
  head -c "$length" >"$input"
fi
require_admin

TOKEN="$(cat "$VAR/token" 2>/dev/null || true)"
PORT="$(cat "$VAR/bridge-port" 2>/dev/null || true)"
case "$PORT" in
  ''|*[!0-9]*) json_error 500 bridge-port ;;
esac
[ -n "$TOKEN" ] || json_error 500 bridge-token

if [ "${REQUEST_METHOD:-GET}" = POST ]; then
  # The check runs in the app's container and may take a while.
  bridge_curl "$TOKEN" -sS --max-time 150 -o "$output" -X POST \
    -H 'Content-Type: application/json' \
    --data-binary "@$input" "http://127.0.0.1:$PORT/config" 2>/dev/null || json_error 502 bridge
else
  path=/config
  [ "$(query_get status)" = 1 ] && path=/config/status
  bridge_curl "$TOKEN" -sS --max-time 30 -o "$output" \
    "http://127.0.0.1:$PORT$path" 2>/dev/null || json_error 502 bridge
fi
case "$(head -c 1 "$output" 2>/dev/null)" in
  '{') ;;
  *) json_error 502 bridge ;;
esac
printf 'Status: 200\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\n\r\n'
cat "$output"
printf '\n'
