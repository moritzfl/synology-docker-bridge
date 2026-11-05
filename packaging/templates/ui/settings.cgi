#!/bin/sh
cd "$(dirname "$0")" || exit 1
. ./auth.sh

body=""
if [ "${REQUEST_METHOD:-GET}" = POST ]; then
  length="${CONTENT_LENGTH:-0}"
  case "$length" in
    ''|*[!0-9]*) json_error 400 length ;;
  esac
  if [ "$length" -gt 262144 ]; then
    head -c "$length" >/dev/null
    json_error 413 size
  fi
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
tmp="$VAR/settings.$$.json"
"$CURL" -sS --max-time 600 -o "$tmp" \
  -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data-binary "$body" "http://127.0.0.1:$PORT/apply" 2>/dev/null || {
    rm -f "$tmp"
    json_error 502 bridge
  }
if [ ! -s "$tmp" ]; then
  rm -f "$tmp"
  json_error 502 bridge
fi
# DSM rewrites 4xx/5xx CGI responses; keep the HTTP status at 200 and let the
# JSON body carry the real result.
printf 'Status: 200\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\n\r\n'
cat "$tmp"
printf '\n'
rm -f "$tmp"
