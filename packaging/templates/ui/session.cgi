#!/bin/sh
cd "$(dirname "$0")" || exit 1
. ./auth.sh
require_access
[ "${REQUEST_METHOD:-GET}" = GET ] || json_error 405 method

VAR="${SYNOPKG_PKGVAR:-/var/packages/{{id}}/var}"
TOKEN="$(cat "$VAR/token" 2>/dev/null || true)"
PORT="$(cat "$VAR/bridge-port" 2>/dev/null || true)"
case "$PORT" in
  ''|*[!0-9]*) json_error 500 bridge-port ;;
esac
[ -n "$TOKEN" ] || json_error 500 bridge-token

CURL="$(command -v curl 2>/dev/null || echo /usr/bin/curl)"
out="$("$CURL" -sS --max-time 20 -X POST \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data-binary "{\"user\":\"$(json_string "$user")\",\"groups\":$(json_groups)}" \
  "http://127.0.0.1:$PORT/session" 2>/dev/null)" || json_error 502 bridge
printf 'Status: 200\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\n\r\n%s\n' "$out"
