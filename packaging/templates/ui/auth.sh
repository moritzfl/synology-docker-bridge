#!/bin/sh
json_error() {
  # DSM replaces 403/500/502 CGI responses with its own error page, which the
  # browser cannot parse. Always answer 200 and let the caller read "error".
  printf 'Status: 200\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\n\r\n{"ok":false,"error":"%s","status":%s}\n' "$2" "$1"
  exit 0
}

query_get() {
  key="$1"
  rest="${QUERY_STRING:-}"
  while [ -n "$rest" ]; do
    pair="${rest%%&*}"
    if [ "$rest" = "$pair" ]; then
      rest=""
    else
      rest="${rest#*&}"
    fi
    case "$pair" in
      "$key"=*)
        printf '%s' "${pair#*=}"
        return
        ;;
    esac
  done
}

require_user() {
  case "${HTTP_SEC_FETCH_SITE:-}" in
    cross-site) json_error 403 origin ;;
  esac
  if [ "${REQUEST_METHOD:-GET}" = "POST" ]; then
    case "${HTTP_ORIGIN:-}" in
      "http://${HTTP_HOST}"|"https://${HTTP_HOST}") ;;
      *) json_error 403 origin ;;
    esac
  fi
  user=$(/usr/syno/synoman/webman/modules/authenticate.cgi 2>/dev/null | tr -d '\r\n')
  [ -n "$user" ] || json_error 401 auth
  token="${HTTP_X_SYNO_TOKEN:-}"
  if [ -z "$token" ]; then
    token=$(query_get SynoToken)
  fi
  [ -n "$token" ] || json_error 403 token
}

is_admin() {
  id -Gn -- "$user" 2>/dev/null | tr ' ' '\n' | grep -Fx administrators >/dev/null
}

json_string() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

# DSM hides the desktop icon from users without the app privilege, but these CGIs are reachable
# by URL, so check the privilege here too. CGIs run as the package user, which may neither call
# DSM's privilege API nor reuse the browser's DSM session (DSM ends a session used from another
# address), so read the rules the way DSM applies them: rules for the user, the user's groups and
# everyone count; a matching deny wins over any allow; an address list limits a rule to those
# addresses. Anything unreadable denies. Administrators always have every privilege.
has_app_privilege() {
  [ "{{allUsers}}" = true ] && return 0
  is_admin && return 0
  uid=$(id -u -- "$user" 2>/dev/null)
  gids=$(id -G -- "$user" 2>/dev/null | tr ' ' ',')
  case "$uid" in ''|*[!0-9]*) return 1 ;; esac
  case "$gids" in ''|*[!0-9,]*) gids=-1 ;; esac
  /usr/bin/sqlite3 -separator '|' /etc/synoappprivilege.db \
      "SELECT AllowIP, DenyIP FROM AppPrivRule WHERE App = 'SYNO.SDS.{{dsmAppName}}.Instance'
         AND ((Type = 0 AND ID = $uid) OR (Type = 1 AND ID IN ($gids)) OR Type = 2)" 2>/dev/null \
    | awk -F'|' -v ip="${REMOTE_ADDR:-}" '
        function num(a,  o) { split(a, o, "."); return ((o[1] * 256 + o[2]) * 256 + o[3]) * 256 + o[4] }
        function bits(m,  o, i, n, v) {
          split(m, o, "."); n = 0
          for (i = 1; i <= 4; i++) { v = o[i] + 0; while (v >= 128) { n++; v = (v - 128) * 2 } }
          return n
        }
        # deny=1: an entry this check cannot evaluate counts as a match, so it fails closed
        function matches(list, deny,  e, i, n, p, s) {
          n = split(list, e, ",")
          for (i = 1; i <= n; i++) {
            if (e[i] == "0.0.0.0") return 1
            if (!v4) { if (deny) return 1; continue }
            split(e[i], p, "/")
            if (p[2] == "") { if (p[1] == ip) return 1; continue }
            s = 2 ^ (32 - bits(p[2]))
            if (int(num(ip) / s) == int(num(p[1]) / s)) return 1
          }
          return 0
        }
        BEGIN { sub(/^::ffff:/, "", ip); v4 = ip ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ }
        { if ($2 != "" && matches($2, 1)) denied = 1; if ($1 != "" && matches($1, 0)) allowed = 1 }
        END { exit !(allowed && !denied) }'
}

# The user's groups as a JSON array, for the session (and the app, with identity headers).
json_groups() {
  list=""
  for group in $(id -Gn -- "$user" 2>/dev/null); do
    list="$list${list:+,}\"$(json_string "$group")\""
  done
  printf '[%s]' "$list"
}

# Ends the user's open sessions in the app, so revoked access takes effect at once.
revoke_sessions() {
  var="${SYNOPKG_PKGVAR:-/var/packages/{{id}}/var}"
  "$(command -v curl 2>/dev/null || echo /usr/bin/curl)" -s --max-time 5 -X POST \
    -H "Authorization: Bearer $(cat "$var/token" 2>/dev/null)" -H 'Content-Type: application/json' \
    --data-binary "{\"user\":\"$(json_string "$user")\"}" \
    "http://127.0.0.1:$(cat "$var/bridge-port" 2>/dev/null)/revoke" >/dev/null 2>&1 || true
}

require_access() {
  require_user
  if ! has_app_privilege; then
    revoke_sessions
    json_error 403 denied
  fi
}

require_admin() {
  require_user
  is_admin || json_error 403 admin
}
