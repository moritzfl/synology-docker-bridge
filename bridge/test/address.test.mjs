import assert from "node:assert/strict";
import test from "node:test";
import { dsmAddress } from "../src/address.mjs";

const ports = { http: 5000, https: 5001 };
const app = "SYNO.SDS.FidusWriter.Instance";

test("under DSM's own address, sign-in is DSM's start page", () => {
  assert.equal(dsmAddress("nas:5001", true, false, ports, app), "https://nas:5001/");
});

test("from the app's own ports, sign-in is DSM on the same host, opening the app", () => {
  const launch = "?launchApp=SYNO.SDS.FidusWriter.Instance";
  assert.equal(
    dsmAddress("nas.local:4387", true, true, ports, app),
    `https://nas.local:5001/${launch}`,
  );
  assert.equal(
    dsmAddress("192.168.1.5:4386", false, true, ports, app),
    `http://192.168.1.5:5000/${launch}`,
  );
  assert.equal(
    dsmAddress("[fd00::5]:4387", true, true, ports, app),
    `https://[fd00::5]:5001/${launch}`,
  );
  assert.equal(dsmAddress("nas", true, true, { http: 80, https: 8001 }, ""), "https://nas:8001/");
});

test("a host that is no plain name or address does not reach the page", () => {
  assert.equal(dsmAddress('nas"><script>', true, true, ports, ""), "https://nas:5001/");
  assert.equal(dsmAddress("", true, true, ports, ""), "https://nas:5001/");
});
