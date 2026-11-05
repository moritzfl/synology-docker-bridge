# Virtual DSM tests

Installs real SPKs in a real DSM 7.2.2 guest ([vdsm/virtual-dsm](https://github.com/vdsm/virtual-dsm))
and drives their windows in a browser. Only DSM's own ports are mapped (`15001` → 5000,
`15002` → 5001), which also proves the packages need no port of their own. The scripts are
generic: they read each package's name and DSM app class from its `INFO`.

## Once

```sh
cd test/e2e
docker compose up -d        # first boot under software emulation is slow
npm install
npx playwright install chromium webkit
node setup.mjs              # creates the DSM administrator and .auth/
```

Then, in the guest's DSM: install and start **Container Manager** from Package Center, and turn
on SSH in **Control Panel → Terminal & SNMP** (the scripts run guest commands over SSH through
`docker exec … nc`, never through a published port).

The scripts find the guest container by its image; set `E2E_DSM_CONTAINER` if several run.

## A round

```sh
node ../../packaging/generate.mjs --config ../../examples/nginx/app.json
node round.mjs ../../packaging/dist/dsm-nginx-demo-<version>-x86_64.spk [<other>.spk]
```

Give the demo first: its `/whoami` page lets the rights test check the identity headers. A
second package adds the side-by-side session check. The round:

| Script | Checks |
| --- | --- |
| `install.mjs <spk>...` | Uploads to the volume (not the guest's small `/tmp`), verifies the checksum, `synopkg install`, waits for both containers |
| `window.mjs <id> <class>` | As administrator: no help button, the one admin control, the folder hint and rejection, moving the folder there and back, the phone dialog (turns the Login Portal address on), a hung app's Restart, silent re-login after the bridge restarts, Start for a stopped app, no page errors |
| `rights.mjs <id> <class> [<id2> <class2>]` | Per-package cookies side by side; a non-admin user without the privilege is refused, also by URL; granted, the app opens and `Remote-User` names them while forged headers are dropped; revoked, the next open is refused and the open session ends on its re-check; German for a German browser |
| `portal.mjs <id>` | The Login Portal address on desktop Chrome and an iPhone: the app on its own, the window as wide as the device, the app's Home Screen icon, Sign Out in the account menu |

Screenshots go to `output/`. `GUEST_TIMEOUT_MS` raises the guest command timeout for slow
installs under emulation.

## Notes

- Guest commands need a full `PATH` for Synology tools; `lib.mjs` sets it.
- The first start after installing loads the embedded images; under emulation (`KVM=N` on Apple
  Silicon) that takes a few minutes.
- The rights test creates a non-admin user `bridge-e2e-user` and edits only its own
  Application Privileges rule.
