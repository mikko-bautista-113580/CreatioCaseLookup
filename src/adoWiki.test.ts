import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { cleanPageContent, flattenTree, getToken, parseTokenOutput, setAzRunner, WikiUnavailable } from "./adoWiki.js";

afterEach(() => setAzRunner(null));

test("token output parses both expiry formats", () => {
  const a = parseTokenOutput(JSON.stringify({ accessToken: "t1", expires_on: 2_000_000_000 }));
  assert.equal(a.token, "t1");
  assert.equal(a.expires, 2_000_000_000_000);
  const b = parseTokenOutput(JSON.stringify({ accessToken: "t2", expiresOn: "2030-01-01 10:00:00.000000" }));
  assert.equal(b.token, "t2");
  assert.ok(b.expires > Date.now());
});

test("the token is cached until near expiry", async () => {
  let calls = 0;
  setAzRunner(async () => {
    calls++;
    return { code: 0, stdout: JSON.stringify({ accessToken: "tok", expires_on: Math.floor(Date.now() / 1000) + 3600 }), stderr: "" };
  });
  assert.equal(await getToken(), "tok");
  assert.equal(await getToken(), "tok");
  assert.equal(calls, 1);
});

test("a missing az becomes WikiUnavailable az-missing", async () => {
  setAzRunner(async () => ({ code: 127, stdout: "", stderr: "spawn az ENOENT" }));
  await assert.rejects(getToken(), (e: unknown) => e instanceof WikiUnavailable && e.reason === "az-missing");
});

test("a logged-out az becomes WikiUnavailable not-logged-in", async () => {
  setAzRunner(async () => ({ code: 1, stdout: "", stderr: "Please run 'az login' to setup account." }));
  await assert.rejects(getToken(), (e: unknown) => e instanceof WikiUnavailable && e.reason === "not-logged-in");
});

test("the tree flattens without the root or image folders", () => {
  const pages = flattenTree({
    path: "/",
    subPages: [
      { path: "/A", id: 1, subPages: [{ path: "/A/B", id: 2 }, { path: "/A/.images" }] },
      { path: "/C", id: 3 },
    ],
  });
  assert.deepEqual(pages, [
    { path: "/A", id: 1, section: true },
    { path: "/A/B", id: 2, section: false },
    { path: "/C", id: 3, section: false },
  ]);
});

test("image embeds are stripped from page content", () => {
  assert.equal(cleanPageContent("Hi ![x](/.images/a.png) <img src=x> [link](u)"), "Hi   [link](u)");
});
