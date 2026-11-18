import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// /proc/<pid>/cmdline is readable by every local user on DSM. A bearer token in curl's arguments
// would hand the whole control API to any of them, so the CGIs pass it on stdin instead.
const ui = fileURLToPath(new URL("../templates/ui/", import.meta.url));
const scripts = fs.readdirSync(ui).filter((name) => /\.(cgi|sh)$/.test(name));
const read = (name) => fs.readFileSync(path.join(ui, name), "utf8");

test("CGIs never put the control token in a process argument", () => {
  assert.match(
    read("auth.sh"),
    /bridge_curl\(\)\s*\{[\s\S]*?--config -/,
    "the helper reads the header from stdin",
  );
  for (const file of scripts) {
    const text = read(file);
    assert.doesNotMatch(text, /-H\s+["']Authorization:/, `${file}: bearer in the curl arguments`);
    assert.doesNotMatch(text, /Bearer \$TOKEN/, `${file}: token interpolated into an argument`);
  }
});

test("admin CGIs check access before storing a request body, in private files", () => {
  for (const file of ["config.cgi", "settings.cgi"]) {
    const text = read(file);
    assert.ok(
      text.indexOf("require_admin") < text.indexOf("head -c"),
      `${file}: access is checked before the body is read`,
    );
    assert.match(text, /umask 077/, `${file}: private files`);
    assert.match(text, /mktemp "\$VAR\//, `${file}: unpredictable temporary names`);
    assert.doesNotMatch(text, /\$\$\.(in|out|json)/, `${file}: no predictable process-id names`);
  }
});

test("every CGI reaches the bridge through the stdin helper", () => {
  for (const file of scripts) {
    const text = read(file);
    if (!text.includes("http://127.0.0.1:")) continue;
    assert.match(
      text,
      /bridge_curl "\$(TOKEN|token)"/,
      `${file}: token-bearing call without helper`,
    );
  }
  assert.match(
    read("settings.cgi"),
    /--data-binary "@\$input"/,
    "the body is a file, not an argument",
  );
});
