#!/usr/bin/env node
/**
 * Creatio read-only MCP server.
 *
 * All Creatio access (auth, cookie handling, the GET-only HTTP path, the query
 * builder, and the entity allowlist) lives in ./creatioClient.ts, which is
 * shared with the local web app. This file is just the MCP surface over it.
 *
 * SAFETY MODEL — see creatioClient.ts. In short: only HTTP GET is ever issued,
 * there are no write tools, an allowlist restricts reachable entities, and $top
 * is clamped. SSO cookies are re-read from .env on demand, so refreshing them
 * there takes effect on the next query with no restart.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  ALLOWED_ENTITIES,
  BASE_URL,
  COOKIE_MODE,
  MAX_TOP,
  assertEntityAllowed,
  buildQuery,
  odataGet,
} from "./creatioClient.js";

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function fail(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text" as const, text: `Error: ${msg}` }] };
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------
const server = new McpServer({ name: "creatio-mcp-readonly", version: "0.1.0" });

server.tool(
  "creatio_list_allowed_entities",
  "List the Creatio OData entity sets this server is permitted to read. " +
    "If the allowlist is empty, all entities are readable.",
  {},
  async () =>
    ok({
      baseUrl: BASE_URL,
      readOnly: true,
      maxTop: MAX_TOP,
      allowlist: ALLOWED_ENTITIES.length ? ALLOWED_ENTITIES : "(none — all entities readable)",
    })
);

server.tool(
  "creatio_query_records",
  "Query records from a Creatio entity via OData (read-only GET). " +
    "Use OData syntax for filter/orderby, e.g. filter: \"Number eq 'SR00042038'\".",
  {
    entity: z.string().describe("OData entity set name, e.g. 'Case' or 'Contact'."),
    select: z.array(z.string()).optional().describe("Columns to return, e.g. ['Id','Number','Subject']."),
    filter: z.string().optional().describe("OData $filter expression."),
    orderby: z.string().optional().describe("OData $orderby, e.g. 'CreatedOn desc'."),
    top: z.number().int().positive().optional().describe(`Max rows (clamped to ${MAX_TOP}).`),
    expand: z.string().optional().describe("OData $expand for lookups, e.g. 'Owner'."),
  },
  async ({ entity, select, filter, orderby, top, expand }) => {
    try {
      assertEntityAllowed(entity);
      const data = await odataGet(entity + buildQuery({ select, filter, orderby, top, expand }));
      return ok(data);
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "creatio_get_record",
  "Fetch a single Creatio record by its GUID Id (read-only GET).",
  {
    entity: z.string().describe("OData entity set name, e.g. 'Case'."),
    id: z.string().describe("Record GUID, e.g. 'f3ed4f55-894b-42bc-b5a1-f10b9d0bc03f'."),
    select: z.array(z.string()).optional().describe("Columns to return."),
    expand: z.string().optional().describe("OData $expand for lookups."),
  },
  async ({ entity, id, select, expand }) => {
    try {
      assertEntityAllowed(entity);
      if (!/^[0-9a-fA-F-]{36}$/.test(id)) throw new Error(`Invalid GUID: ${id}`);
      const q = buildQuery({ select, expand, top: 1 }).replace(/^\?/, "");
      const path = `${entity}(${id})${q ? "?" + q.replace(/&?\$top=\d+/, "") : ""}`;
      const data = await odataGet(path);
      return ok(data);
    } catch (e) {
      return fail(e);
    }
  }
);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[creatio-mcp] read-only server ready. base=${BASE_URL} auth=${COOKIE_MODE ? "cookie(SSO)" : "forms"} allowlist=[${ALLOWED_ENTITIES.join(", ") || "*"}] maxTop=${MAX_TOP}`
  );
}

main().catch((e) => {
  console.error("[creatio-mcp] fatal:", e);
  process.exit(1);
});
