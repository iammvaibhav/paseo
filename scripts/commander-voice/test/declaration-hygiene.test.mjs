// Commander Voice — declaration hygiene (spec 03). Verifies the Gemini
// function declarations mirror the Commander tool contract: full closed
// enums (no "running, idle, …" prose ellipses), post_answer declares
// agentId/fields/respondsTo, clarify declares allowFreeText, and the roster
// tool declares the new bucket/query inputs.
//
// Run:  node --test test/declaration-hygiene.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { getToolDeclarations } from "../lib/tools.js";

const ALL_DECLARATIONS = getToolDeclarations("direct");

function declarationFor(name) {
  return ALL_DECLARATIONS.find((declaration) => declaration.name === name);
}

function propertyNames(declaration) {
  return Object.keys(declaration.parameters.properties ?? {});
}

test("fleet_list_agents statuses enumerates the full lifecycle enum, never an ellipsis", () => {
  const declaration = declarationFor("fleet_list_agents");
  assert.ok(declaration, "fleet_list_agents must be declared in direct mode");
  const statuses = declaration.parameters.properties.statuses;
  assert.ok(statuses, "statuses input must be declared");
  for (const status of ["initializing", "idle", "running", "error", "closed"]) {
    assert.ok(
      statuses.description.includes(status),
      `statuses description must enumerate ${status}`,
    );
  }
  assert.ok(!statuses.description.includes("..."), "no prose ellipsis in statuses");
});

test("fleet_list_agents declares the closed-enum bucket filter and the name query", () => {
  const declaration = declarationFor("fleet_list_agents");
  const names = propertyNames(declaration);
  assert.ok(names.includes("bucket"), "bucket filter must be declared");
  assert.ok(names.includes("query"), "name-resolution query must be declared");
  const bucket = declaration.parameters.properties.bucket;
  for (const value of ["needs_you", "running", "ready", "done", "idle"]) {
    assert.ok(bucket.description.includes(value), `bucket must enumerate ${value}`);
  }
});

test("post_answer declares agentId, fields, and respondsTo", () => {
  const declaration = declarationFor("post_answer");
  assert.ok(declaration, "post_answer must be declared in direct mode");
  const names = propertyNames(declaration);
  for (const field of ["agentId", "fields", "respondsTo"]) {
    assert.ok(names.includes(field), `post_answer must declare ${field}`);
  }
  const fields = declaration.parameters.properties.fields;
  assert.ok(fields, "fields must be declared");
  assert.equal(fields.items.type, "OBJECT", "fields items must be objects with label/value");
});

test("clarify declares allowFreeText", () => {
  const declaration = declarationFor("clarify");
  assert.ok(declaration, "clarify must be declared in direct mode");
  assert.ok(
    propertyNames(declaration).includes("allowFreeText"),
    "clarify must declare allowFreeText",
  );
});

test("fleet_send_prompt mode is fully enumerated with no ellipsis", () => {
  const declaration = declarationFor("fleet_send_prompt");
  const mode = declaration.parameters.properties.mode;
  for (const value of ["steer", "interrupt", "queue"]) {
    assert.ok(mode.description.includes(value), `mode must enumerate ${value}`);
  }
  assert.ok(!mode.description.includes("..."), "no prose ellipsis in mode");
});

test("relay mode declares the shared read tools with the same roster surface", () => {
  const relay = getToolDeclarations("relay");
  const agents = relay.find((declaration) => declaration.name === "fleet_list_agents");
  assert.ok(agents, "relay must declare fleet_list_agents");
  for (const name of ["bucket", "query", "statuses"]) {
    assert.ok(name in (agents.parameters.properties ?? {}), `relay roster must declare ${name}`);
  }
});
