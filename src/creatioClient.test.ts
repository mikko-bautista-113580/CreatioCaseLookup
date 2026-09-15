/**
 * Contract test for the connection probe.
 *
 * An unqualified OData read (no $select) asks Creatio to serialize EVERY column
 * of the entity, so a single column that fails to serialize turns a perfectly
 * healthy session into "HTTP 500 ObjectContent`1 type failed to serialize" —
 * which the Settings screen then reports as a credentials problem. Probing one
 * primary key tests exactly what the check is for: session + reachability.
 *
 * Pure path assertions, so the contract holds without touching the network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { connectionProbePath } from "./creatioClient.js";

test("connection probe narrows $select to a single column", () => {
  // URLSearchParams percent-encodes '$', hence %24.
  assert.match(connectionProbePath(), /%24select=Id(&|$)/);
});

test("connection probe reads a single row", () => {
  assert.match(connectionProbePath(), /%24top=1(&|$)/);
});
