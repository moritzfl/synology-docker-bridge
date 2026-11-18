#!/bin/sh
cd "$(dirname "$0")" || exit 1
. ./auth.sh
require_admin
[ "${REQUEST_METHOD:-GET}" = POST ] || json_error 405 method

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

VAR="${SYNOPKG_PKGVAR:-/var/packages/{{id}}/var}"
TOKEN="$(cat "$VAR/token" 2>/dev/null || true)"
PORT="$(cat "$VAR/bridge-port" 2>/dev/null || true)"
case "$PORT" in
  ''|*[!0-9]*) json_error 500 bridge-port ;;
esac
[ -n "$TOKEN" ] || json_error 500 bridge-token

# Private files with unpredictable names: the body may contain secrets, and the package folder is
# writable by the package's user.
umask 077
input="$(mktemp "$VAR/settings.XXXXXX")" || json_error 500 temp
trap 'rm -f "$input"' EXIT
tmp="$(mktemp "$VAR/settings.XXXXXX")" || json_error 500 temp
trap 'rm -f "$input" "$tmp"' EXIT
printf '%s' "$body" >"$input"

bridge_curl "$TOKEN" -sS --max-time 600 -o "$tmp" \
  -X POST -H 'Content-Type: application/json' \
  --data-binary "@$input" "http://127.0.0.1:$PORT/apply" 2>/dev/null || json_error 502 bridge
if [ ! -s "$tmp" ]; then
  json_error 502 bridge
fi
# DSM rewrites 4xx/5xx CGI responses; keep the HTTP status at 200 and let the
# JSON body carry the real result.
printf 'Status: 200\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\n\r\n'
cat "$tmp"
printf '\n'
