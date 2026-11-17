#!/bin/sh
# Lets an administrator skip the newer version on offer, so the window and DSM stop mentioning it.
cd "$(dirname "$0")" || exit 1
. ./auth.sh

body=""
if [ "${REQUEST_METHOD:-GET}" = POST ]; then
  length="${CONTENT_LENGTH:-0}"
  case "$length" in
    ''|*[!0-9]*) json_error 400 length ;;
  esac
  [ "$length" -le 4096 ] || json_error 413 size
  body=$(head -c "$length")
fi
require_admin
[ "${REQUEST_METHOD:-GET}" = POST ] || json_error 405 method

VAR="${SYNOPKG_PKGVAR:-/var/packages/{{id}}/var}"
TOKEN="$(cat "$VAR/token" 2>/dev/null || true)"
PORT="$(cat "$VAR/bridge-port" 2>/dev/null || true)"
case "$PORT" in
  ''|*[!0-9]*) json_error 500 bridge-port ;;
esac
[ -n "$TOKEN" ] || json_error 500 bridge-token

CURL="$(command -v curl 2>/dev/null || echo /usr/bin/curl)"
out="$("$CURL" -sS --max-time 20 -X POST -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' --data-binary "$body" \
  "http://127.0.0.1:$PORT/updates" 2>/dev/null)" || json_error 502 bridge
case "$out" in
  '{'*) ;;
  *) json_error 502 bridge ;;
esac
printf 'Status: 200\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\n\r\n%s\n' "$out"
