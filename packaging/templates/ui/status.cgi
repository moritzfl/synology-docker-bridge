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

# Tell the window whether to offer admin-only actions (Settings, Restart, Start), and include
# folder paths in the answer only for administrators.
admin=false
is_admin && admin=true
path=/status
[ "$admin" = true ] && path="/status?admin=1"
out="$(bridge_curl "$TOKEN" -sS --max-time 20 \
  "http://127.0.0.1:$PORT$path" 2>/dev/null)" || json_error 502 bridge
case "$out" in
  '{'*) ;;
  *) json_error 502 bridge ;;
esac
printf 'Status: 200\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\n\r\n{"isAdmin":%s,%s\n' "$admin" "${out#\{}"
