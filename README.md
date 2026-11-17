# Synology Docker Bridge

A small, generic runtime that puts an existing Docker web UI into a DSM desktop window and adds
NAS-aware controls without teaching the application image anything about Synology.

The application stays a normal OCI image. The bridge is an additional container in the package's
compose project. DSM's own nginx reverse-proxies the app under
`/webman/3rdparty/<id>/proxy/`, so the desktop window uses DSM's own HTTP and HTTPS ports — no
extra port, no firewall rule, no certificate exception. The bridge also exposes a localhost-only
control API for the package UI.

```
DSM desktop icon                       Login Portal address (phones, browser tabs)
  └─ SYNO.SDS.AppWindow (Ext, package UI)  ◄── https://<nas>:<dsm-port>/<id>/
       ├─ toolbar (administrators only): Manage ▾ (folder…, Open on phones…)
       └─ iframe: /webman/3rdparty/<id>/app.html (same origin as DSM)
            └─ iframe: /webman/3rdparty/<id>/proxy/app/
                 └─ DSM nginx (5000/5001) ──► 127.0.0.1:<bridge-control-port>
                      └─ bridge proxy ──► 127.0.0.1:<internal-port>
```

## Example: AirPlay Capture in DSM

This is [AirPlay Capture](https://github.com/moritzfl/airplay-capture), packaged with this bridge
and running in DSM 7.2.2. The application fills a normal DSM desktop window; the bridge adds only
the native window chrome and the administrator's **Manage** menu.

![AirPlay Capture running in a DSM desktop window](docs/images/airplay-capture-dsm-window.png)

## Why a proxy instead of publishing the app directly?

- The user never sees a port, a certificate warning, or a second URL. The app behaves like a
  first-party DSM application.
- DSM nginx terminates TLS with the existing DSM certificate, on whatever ports DSM uses.
- The app image stays untouched and works outside Synology with `docker run -p ...`.
- The app can use host networking (AirPlay, mDNS, DLNA) or bridge networking.

The app must expose its web UI on one fixed container port, bound to localhost. The public path is
the bridge's.

## Repository layout

| Path                              | Purpose                                                                                 |
| --------------------------------- | --------------------------------------------------------------------------------------- |
| `bridge/`                         | Node.js bridge: proxy, sessions, control API, Docker Engine API, folder moves           |
| `packaging/generate.mjs`          | SPK generator; `--check` validates a config without Docker                              |
| `packaging/app.schema.json`       | JSON schema for app configs (editor completion and checks)                              |
| `packaging/texts.json`            | Every text the window shows, in English and German                                      |
| `packaging/templates/`            | SPK template: INFO, compose, scripts, DSM AppWindow, CGI, nginx and Login Portal config |
| `packaging/test/`, `bridge/test/` | Unit tests (`npm test`)                                                                 |
| `test/e2e/`                       | Installs real SPKs in Virtual DSM and drives their windows; see its README              |
| `examples/nginx/`                 | Demo: nginx plus a `/whoami` page that shows the identity headers                       |

## Quick start

Requirements: Node.js 22 or newer (26 LTS recommended for development), Docker with buildx,
and `rsvg-convert` for SVG icons (`brew install librsvg`).

```sh
(cd bridge && npm ci)
npm test
node packaging/generate.mjs --config examples/nginx/app.json --check
node packaging/generate.mjs --config examples/nginx/app.json
```

The result is `packaging/dist/dsm-nginx-demo-<version>-x86_64.spk`. Install it through
**Package Center → Manual Install**, start it, and open the desktop icon.

## App configuration

A minimal config:

```json
{
  "$schema": "../synology-docker-bridge/packaging/app.schema.json",
  "id": "my-app",
  "version": "1.0.0",
  "displayName": "My App",
  "description": "Short description",
  "maintainer": "Me",
  "image": "my-app:spk",
  "appBuild": "docker build -t my-app:spk .",
  "containerPort": 8080,
  "icon": "icon.svg"
}
```

Everything else has a default; `app.schema.json` documents every field. The ones most apps touch:

| Field                              | Meaning                                                                                                                                                                                                                                   |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                               | Package name; also the data share, container, and Login Portal alias. Lowercase and dashes                                                                                                                                                |
| `icon`                             | One square SVG, drawn at every size DSM uses. Or `icons`: a folder of ready-made PNGs                                                                                                                                                     |
| `image`, `appBuild`                | The local app image to embed, and an optional command that builds it (run in `appDir`, with `SPK_PLATFORM` set to the Docker platform, e.g. `linux/arm64`)                                                                                |
| `arch`                             | `x86_64` (default) or `armv8` for ARM models with Container Manager; `--arch` overrides it per build, so one config yields both packages                                                                                                  |
| `containerPort`                    | Port the app listens on inside its container                                                                                                                                                                                              |
| `networkMode`                      | `bridge` (default) or `host`; with `host`, `internalPort` must equal `containerPort`                                                                                                                                                      |
| `appPath`                          | Web path of the app's UI (`/` or `/app/`)                                                                                                                                                                                                 |
| `appUser`                          | User the app runs as. Default: the image's own, like `docker run` (root when the image sets none). `package`: the package's own DSM user; see [Which folders the app may use](#which-folders-the-app-may-use)                             |
| `init`                             | `true`: a minimal init in the app container reaps orphaned child processes (`docker run --init`)                                                                                                                                          |
| `publicPaths`                      | App paths visitors may fetch without signing in, e.g. `["/media/"]`; see [Paths without sign-in](#paths-without-sign-in)                                                                                                                  |
| `hostTimezone`                     | Default `true`: `TZ` names the NAS time zone, e.g. `Europe/Berlin`, read on install and upgrade. An app's own `TZ` in `appEnv` wins                                                                                                       |
| `appEnv`                           | Extra environment; `${APP_CONTAINER_PORT}` and `${APP_OUTPUT_CONTAINER_DIR}` are filled in                                                                                                                                                |
| `dataDir`                          | Host folder mounted at `/data`. Default: the package's own shared folder (administrators only), on whichever volume DSM created it                                                                                                        |
| `output`                           | `false` for apps that write nothing to a share: no folder setting, no share mounted                                                                                                                                                       |
| `outputShare`, `outputSubdir`      | The shared folder the folder must be in (`music`) and the first folder in it (`id`). DSM creates the share when it is missing, the way its own media apps do; an existing share keeps its permissions. The package finds it on any volume |
| `outputLabel`                      | What the folder is called, as text or `{ "enu": …, "ger": … }`                                                                                                                                                                            |
| `displayNameGer`, `descriptionGer` | German name and Package Center description                                                                                                                                                                                                |
| `allUsers`                         | `true`: every DSM user may open the app. Default `false`: administrators grant it                                                                                                                                                         |
| `identityHeaders`                  | `true`: the app receives `Remote-User`, `Remote-Groups`, `Remote-Name` and `Remote-Email` for the signed-in DSM user                                                                                                                      |
| `webPorts`                         | `{ "http": …, "https": … }` for apps that only work at the root of an address; see [Apps on ports of their own](#apps-on-ports-of-their-own)                                                                                              |
| `files`                            | Files the package brings for an unmodified image, mounted read-only: `{ "/data/settings.py": "settings.py" }`                                                                                                                             |
| `publicCookies`                    | The app's cookies visitors without a session keep on `publicPaths`, e.g. `["csrftoken"]`                                                                                                                                                  |
| `command`                          | Start command for the unmodified image, e.g. a script brought in with `files` that then runs the image's own                                                                                                                              |
| `configFile`                       | A settings file in the data folder that administrators edit in the window; see [Settings](#settings)                                                                                                                                      |
| `updates`                          | Look for newer versions of the published image; see [Updates](#updates)                                                                                                                                                                   |
| `authMode`                         | `token` (default) or `none` for apps with their own sign-in                                                                                                                                                                               |

Derived when not given: `dsmAppName` (`my-app` → `MyApp`), `container` (`id`), `internalPort` and
the bridge control port (from `id`, so packages never collide), `bridgeImage` (`<id>-bridge:spk`).
The generator also accepts `--arch`, `--skip-app-build`, `--skip-bridge-build`, and `--output`.

Every SPK records the framework version and commit (`0.2.0+<commit>`); the bridge logs it at start
and reports it in its status.

## What the user sees

In AirPlay Capture, administrators change the recordings folder through a native DSM dialog,
including moving existing files, without touching Compose or a terminal.

![AirPlay Capture's recordings-folder dialog in DSM](docs/images/airplay-capture-dsm-folder.png)

The window is meant to behave like a first-party DSM app, so the bridge never shows a raw port,
container state or helper error code. Every text is in the user's DSM language (English or
German).

- **The window is the app**: no Restart or Open in browser button, and no "?" (DSM's help has no
  page for packages). Users get the app edge to edge. Administrators get one **Manage ▾** button
  with the folder (named by `outputLabel`) and **Open on phones…**; apps without a folder show
  that one item as a plain button.
- **Opening**: the window shows the app icon with "Starting <app>" while the container starts and
  reveals the app as soon as it answers. After two minutes it says it is taking longer than usual
  and offers Try again, but keeps waiting. If the app runs but stops answering, administrators
  also get **Restart <app>** there; besides Package Center's Stop/Run, that is the only restart.
- **Stopped app**: "<app> is not running" with a Start button for administrators; other users are
  told to ask an administrator.
- **Errors**: a plain sentence (session ended, no permission, helper not responding, package
  incomplete) with Try again, never a JSON code.
- **The folder**: the dialog says which share folders must be in, starts the chooser in the current
  folder, and rejects other folders next to the field. Saving moves existing files (optional),
  restarts the app and shows what is happening; only files that could not be moved are reported.
- **Sessions**: bridge sessions end after `sessionSeconds` of inactivity (default 8 hours) and when
  the bridge restarts. Inside the DSM window the user is still signed in to DSM, so the wrapper
  silently mints a new session; nobody sees a sign-in page in the middle of DSM.
- There is no port setting: the app is only ever reached through DSM's own address. Copy is
  app-neutral; nothing in the framework names a particular app.

The embedded app can trigger the same handling itself: same-origin pages may post
`{type: "bridge:reauth"}` or `{type: "bridge:unavailable"}` to `window.parent`. The bridge's own 401
and 502 pages already do this.

## Phones and browser tabs

DSM's mobile web view has a fixed menu of Synology's own modules; packages cannot add entries.
Instead, each package registers with **Login Portal** (`web-config` → `app-portal`), the way File
Station offers `/file`. DSM keeps the address off until an administrator turns it on: in the
window with **Manage → Open on phones… → Turn on**, or in **Control Panel → Login Portal →
Applications**. The app is then at `https://<nas>:<dsm-port>/<id>/`:

- DSM's own sign-in page, including 2-factor and SSO, then the app on its own, full page, with DSM's
  account menu (Sign Out). Application Privileges apply as on the desktop.
- On phones the page uses the device width, so the app's own mobile layout applies, and it can be
  added to the Home Screen with the app's name and icon; from there it opens without Safari's
  bars. DSM sizes its window only once, before the phone viewport applies, and Safari sends no
  resize event for that change, so the window follows the page size itself.
- The alias can also get its own port or host name in Control Panel; that is DSM's setting, not
  the package's.

The same AirPlay Capture package through DSM Login Portal on an iPhone:

<img
  src="docs/images/airplay-capture-dsm-mobile.png"
  alt="AirPlay Capture using DSM Login Portal on an iPhone"
  width="393"
/>

## Who can open the app

- Access is controlled by DSM **Application Privileges**. `allUsers` defaults to `false`;
  an administrator grants users/groups in **Control Panel → Application Privileges**.
  Administrators always have access.
- The privilege is enforced on the server, not only by hiding the icon. `status.cgi` and
  `session.cgi` run as the package user, which may not call DSM's privilege API, so they read
  DSM's rules (`/etc/synoappprivilege.db`) the way DSM applies them: rules for the user, the
  user's groups and everyone count, a deny wins over any allow, and an address list limits a rule
  to those addresses. Anything unreadable denies. Users without the privilege see "You do not have
  permission to open …" and get no session.
- While the app is open, the window re-checks the privilege every 10 minutes in the background.
  The bridge trusts a session only for 30 minutes after the last check and ends a user's sessions
  as soon as a check is denied, so taking the privilege away closes an open window too.
- The proxy path requires a bridge session. The wrapper calls `session.cgi`, which authenticates the
  DSM user and asks the bridge for a one-time token. The browser exchanges that token for an
  HttpOnly `dsm_bridge_session` cookie on the DSM origin. The bridge never calls DSM itself.
- The session cookie is scoped to the package's own proxy path, so several bridge packages can be
  open side by side. It is stripped before the request reaches the app. The app still sees its
  own cookies; cookies it sets on an absolute path are moved under the proxy path so they never
  land on DSM's own pages.
- With `identityHeaders: true`, every request reaches the app with `Remote-User: <DSM user>`,
  `Remote-Groups: <groups>` (comma-separated; administrators are in `administrators`) and, when the
  DSM account has them, `Remote-Name: <full name>` and `Remote-Email: <address>`, the convention of
  Authelia and oauth2-proxy, so the app can show per-user data or admin-only features without a
  second sign-in. Names that are not ASCII arrive as their UTF-8 bytes. The bridge always removes
  these headers from what the browser sends, so the app can trust them.
- The address is the one set for a local DSM user in Control Panel or Personal. Only root can read
  DSM's user database, so the bridge does, through a read-only mount of `/etc` (DSM replaces the
  file on every change, which a mount of the file alone would miss). Domain and LDAP users have
  no address there.
- The app's port is on localhost, where any other process on the NAS, including containers with
  host networking, could send `Remote-User` itself. The bridge therefore also sends
  `X-Bridge-Secret`, a random value it keeps in the app's data folder as `/data/.bridge-secret`,
  readable only by the app's user. An app should trust the identity headers only when that
  header matches the file.
- `authMode: "none"` disables the bridge check for apps that already have their own sign-in.

For host-network apps, bind the app's web UI to `127.0.0.1`. Otherwise the internal port is
reachable on the LAN and bypasses the bridge; other ports (RAOP, mDNS, DLNA) stay on the normal
interfaces.

## Apps on ports of their own

Most web apps work under the package's path on DSM's address. Apps whose pages and scripts assume
they sit at the root of an address (`/api/`, `/static/`, `/ws/`) do not, and the bridge does not
rewrite page content. For them, `webPorts` gives the app an address of its own on DSM's web
server, for example `https://<nas>:4387/`:

- DSM's nginx listens on both ports with DSM's default certificate and forwards to the bridge, so
  the bridge still checks every request and the app still has no port of its own on the network.
- The desktop window, and Login Portal, open the app there, in the same window as always: HTTPS
  when DSM was opened over HTTPS, HTTP otherwise. The session cookie is named after the package,
  since cookies do not tell ports apart.
- Opened directly, without a session, the address sends people to DSM, which opens the app's
  window after sign-in. Bookmarks keep working.
- The ports appear in DSM's firewall list under the app's name. When the firewall blocks them,
  the window says so and names the port instead of showing an empty frame.
- Browsers send DSM's sign-in cookies to every port of the NAS. The bridge removes them before
  requests reach the app, and drops cookies the app tries to set under their names.
- `publicPaths` are served there too, at the root, to visitors without a session; see below.
- The app runs at the root of its address on the same host as DSM; script in it can still reach
  DSM's web API from the user's browser, so the same trust applies as below.

## Settings

Many images read settings from a file in their data folder. `configFile` names that file, and
administrators edit it in the window: **Manage → Settings…** (the name is `configFile.label`).
Nobody needs File Station, a text editor package, or a terminal, and a mistake never leaves the
app unusable:

- **Check first**: with `configFile.check`, saving runs that command in the app's container on the
  new text (`{file}` is its path there), before anything changes. A failing check shows its
  output next to the text, and the file stays as it was. Output of a passing check is shown as
  notes after the app restarts.
- **Restart and watch**: the saved file takes effect when the app restarts. The window shows the
  restart, and the bridge watches the app: it must be up and stay up for 30 seconds in the same
  container. Up means it answers, or, with `configFile.ready`, that this command succeeds in the
  app's container, for apps that show a maintenance page while they set up.
- **Undo**: if it does not, the bridge puts the previous file back and restarts the app again. The
  editor reopens with the administrator's text and what the app logged, so it can be fixed.
- Someone else saving in the meantime is detected; the editor says so instead of overwriting.
- The file is the app's own: it stays in the data folder across upgrades and can still be edited
  there directly, without the check.

## Updates

Publishers usually ship a new package with each new image. With `updates`, the bridge looks for
those versions: once a day it lists the published image's tags anonymously, as `docker pull`
would, from Docker Hub, GitHub, Quay or any other registry, and keeps the newest release tag above
the version the package carries. Tags such as `latest` or pre-releases such as `5.0.0a3` do not
count.

- Administrators see a small **Update available** button on the right of the window's toolbar.
  It opens a short dialog: the new and the installed version, a link to `updates.url` (where the
  publisher offers the package), and how to install it in Package Center. **Skip this version**
  hides the button until the next one. Other users never see it.
- `updates: true` checks the packaged image under its own tag. For a locally built image, name the
  published one in `updates.image` and the version in `updates.current`.
- DSM's own notifications are not available: DSM refuses notification texts (`sysnotify`) and
  scheduled jobs from packages it did not sign, and its desktop notifications only take texts
  DSM registered. The hint therefore stays in the window, where administrators act on it.

## Paths without sign-in

Some apps hand other devices or people a link: a speaker downloads audio, an OAuth provider sends
a browser back, someone outside gets a share link to a document. They have no DSM session.
`publicPaths` lists exactly those app paths. DSM's nginx serves them at
`http://<nas>:<dsm-port>/webman/3rdparty/<id>/public/…` on DSM's own ports, or, for an app with
[ports of its own](#apps-on-ports-of-their-own), at the root of those ports, next to everything
else; requests there with a session reach the app signed in as usual:

- Only the listed paths reach the app; a trailing slash allows the path and everything below it.
  Every other path is not found, or, on the app's own ports, sends people to DSM's sign-in. Dot
  segments and encoded separators are resolved before the check. WebSockets count too on the
  app's own ports.
- Requests carry no identity headers, so the app sees them as anonymous, and no cookies except
  those listed in `publicCookies`, such as a CSRF cookie the app's pages need. The app's own login
  cookie is never among them: it would let someone keep using the app after DSM took the
  privilege away. Keep these paths unguessable or harmless, or let the app check access itself,
  as with a share token.
- No buffering: what the app writes reaches the device as it is written, for streamed audio.
- The app gets `APP_PUBLIC_URL` (also as `${APP_PUBLIC_URL}` in `appEnv`): the NAS's LAN address
  on DSM's HTTP port plus the prefix, or on the app's own HTTP port, found on install and upgrade.
- People outside the home network reach these paths only where the NAS is reachable from there,
  for example through port forwarding on the router; DSM lists the ports under the app's name.
- DSM's "redirect HTTP to HTTPS" setting does not affect these paths: DSM redirects in its sign-in
  page, not in nginx. Devices that only accept HTTPS need a certificate they trust on DSM's
  HTTPS port.

## Which folders the app may use

By default the app runs as its image's user, often root, and can use whatever is mounted. With
`appUser: "package"` it runs as the package's own DSM user instead, a **system internal user**
named after the package, the way native packages do. DSM's shared folder permissions and ACLs
then decide what the app may read and write, also inside its container:

- The package's own shared folder (its data) is granted to that user on install, and nothing
  else is. The output folder, and any folder an administrator picks, needs the administrator's
  permission first; selecting a folder grants nothing.
- Administrators get **Manage → Folder access…**. It lists the folders the app uses and checks
  them as the app's user: it lists the folder and creates and removes one empty folder in it.
  **Permissions…** opens DSM's own permission dialog for that folder: the shared folder's
  Permissions with System internal user and the package selected, or File Station's Permission
  tab for a folder inside a share. The window never changes permissions itself; it checks again
  when the dialog closes.
- The window opens Folder access by itself for administrators when a folder needs attention,
  for example right after installing, and after the output folder changes.

Container Manager runs a service without a `user` line as the package user, with the user's
numeric ids; the bridge reads them from the container to run its check.

### Security: trust the images you package

The app is served from DSM's own origin, which is what lets it sit in a DSM window without extra
ports or certificate warnings. The flip side: script in the app runs with the same rights as DSM's
own pages and can call DSM's web API as whoever has the window open, administrators included. A
malicious or compromised image could change DSM settings with an administrator's session. Only
package images you trust, and keep them updated like DSM itself.

The bridge container runs as root with the Docker socket; treat it as a privileged local
component. With `identityHeaders`, it also reads `/etc` (read-only) for DSM's user database. Its control API binds `127.0.0.1` only and requires a bearer token from
`/var/packages/<id>/var/token`.

## What the bridge does

- **Auth**: bridge sessions for HTTP and WebSocket requests on the proxy path, identity headers.
- **Proxy**: HTTP and WebSocket, preserving the public `Host` header; strips frame-blocking
  headers and keeps the app's redirects and cookies under the proxy path.
- **No port of its own**: DSM nginx terminates TLS and forwards to the localhost-only control port.
  An app that needs a port for its own clients (an API, a media protocol) publishes it in its
  compose service, not through the bridge.
- **Docker**: talks to the Docker Engine API over the socket; no Docker CLI in the image.
- **Output change**: validates the path below the output parent, stops the app, optionally moves
  existing entries with `mv` (cross-volume safe), repoints `<parent>/.<id>-folder`, writes `.env`,
  and starts the app again. The container is not recreated, so Container Manager keeps its IDs.
- **Restart**: restarts the app container.
- **Settings**: reads and writes the app's settings file, runs its check in the app's container
  (Docker exec), and restores the previous file when the app does not come back.
- **Updates**: lists the published image's tags daily and keeps the newest release.
- **Status**: container state plus a real HTTP probe of the app.
- **State**: writes both `/compose/.env` (Compose substitution) and `/run/bridge/app.env`
  (survives package upgrades).
- **Disk**: upgrades preload new images under the same tags. The bridge records which image ids its
  two containers run and, a minute after the next start, removes the replaced ones. It only removes
  ids it recorded and never forces removal, so images used by any other container stay.

## Package lifecycle

- `postinst` creates the token, allocates the bridge control port, and writes `.env`.
- Container Manager creates the containers from the `docker/.env` shipped in the package, not the
  one `postinst` writes, so nothing that varies per NAS may come from there. Shares are mounted
  through DSM's per-package links (`/var/packages/<id>/shares/<share>`) and the bridge reads the
  output share's real path from that link at start.
- `data-share` declares the package's own share (admin-only) and the output share; DSM creates
  either when missing and keeps both on uninstall.
- `preupgrade` saves `.env`; `postupgrade` restores it and updates image tags.
- `start-stop-status` waits up to a minute for both containers and never fails the package start.
- `install_dep_packages="ContainerManager"` makes DSM start the package after the Docker daemon is
  ready. Without it the project start worker runs too early and marks the package broken.
- The `docker-project` worker preloads `image.tar` (app + bridge) and manages the compose project.
- The `web-config` worker registers `config/dsm.bridge.conf` in DSM nginx, so the proxy path works
  on whatever ports DSM uses, and registers the Login Portal application. DSM's app-portal worker
  needs the files named after the package and an `alternatePort` entry, or the package fails to
  start.
- The bridge keeps Container Manager's per-container config IDs in sync. DSM recreates containers
  on upgrade but does not refresh those IDs, which would break the next boot.
- There is no install wizard. The output folder is changed in the window.

## Verification

CI tests Node.js 22 and 26. The bridge container stays on Node.js 22: containers share DSM's
kernel, and [Node.js 26 lists Linux 6.12 or newer for x64 Alpine/musl](https://github.com/nodejs/node/blob/v26.13.1/BUILDING.md#platform-list).
Virtual DSM 7.2.2 uses Linux 4.4.

- `npm ci` installs the formatting tool. Run `npm run format` to apply Prettier and
  `npm run format:check` to check formatting as CI does. DSM packaging templates are excluded.
- `npm test`: bridge sessions, identity, cookies, Docker API mapping, image cleanup, path
  validation; the generator's rendering, shell syntax, JSON, switches, and text coverage.
- `test/e2e/`: real installs and window tests on Virtual DSM 7.2.2 over HTTP and HTTPS, with only
  DSM's ports exposed. DSM's AppWindow, file chooser, Login Portal and CGI environment are
  DSM-internal; re-run the round for each DSM version you target.
- Real phones: the Home Screen name and icon are checked in an emulated iPhone; check a real one
  when it matters.

Dependency updates are configured in `renovate.json` for npm packages, Docker images, and GitHub
Actions. Give the [Mend Renovate GitHub App](https://github.com/apps/renovate) access to this
repository to receive update PRs. Updates are not merged automatically.

## License

MIT License, see [LICENSE](LICENSE).
