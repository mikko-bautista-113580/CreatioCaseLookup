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
import {
  peekDistrictIndex,
  listDistricts,
  districtHistory,
  caseByNumber,
  indexStats,
  statusesPresent,
  isOpenStatus,
  HISTORY_SINCE,
  NO_DISTRICT,
  type DistrictCaseRow,
} from "./districtIndex.js";

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
    select: z
      .array(z.string())
      .optional()
      .describe(
        "Columns to return, e.g. ['Id','Number','Subject']. Strongly recommended — " +
          "omitting it reads ALL columns, which some Creatio entities (Case, Contact) " +
          "fail to serialize with HTTP 500."
      ),
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
    select: z
      .array(z.string())
      .optional()
      .describe(
        "Columns to return. Strongly recommended — omitting it reads ALL columns, " +
          "which some Creatio entities (Case, Contact) fail to serialize with HTTP 500."
      ),
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
// District tools
// ---------------------------------------------------------------------------
// These read the local district index built by the web app (Districts tab ->
// "Build index"). They deliberately never build it themselves: the first build
// pages through ~185k case headers over several minutes, which is not something
// a tool call should do behind the model's back. If the index is missing, the
// tools say so and point at the app.

const NOT_BUILT = {
  error: "district_index_not_built",
  message:
    "The district index has not been built yet. Run the web app (npm run app), " +
    "open the Districts tab and click \"Build index\". The first build takes a " +
    "few minutes and saves progress as it goes.",
};

/** Trim a row down to what is useful in a tool response. */
function slimRow(r: DistrictCaseRow) {
  return {
    number: r.number,
    subject: r.subject,
    status: r.status,
    open: isOpenStatus(r.status),
    createdOn: r.createdOn,
    owner: r.owner,
    account: r.accountName,
    districtCode: r.code,
    /** 'account' = authoritative NltDistrictCode. 'subject'/'description' = inferred from text. */
    codeSource: r.source,
  };
}

server.tool(
  "creatio_list_districts",
  "List SIS district codes (Account.NltDistrictCode) with how many cases each has " +
    "in the indexed window. Use this to find a district code before asking for its " +
    "ticket history. Search matches the code or the account/school name.",
  {
    search: z
      .string()
      .optional()
      .describe("Filter by district code or school/account name, e.g. 'HCA' or 'Heritage'."),
    limit: z.number().int().positive().optional().describe("Max districts to return (default 50)."),
  },
  async ({ search, limit }) => {
    try {
      const ix = await peekDistrictIndex();
      if (!ix || !ix.cases.size) return ok(NOT_BUILT);
      const { districts, noDistrict, totalCodes } = listDistricts(ix, {
        search,
        limit: limit ?? 50,
      });
      return ok({
        window: indexStats(ix),
        totalCodes,
        shown: districts.length,
        districts: districts.map((d) => ({
          code: d.code,
          accounts: d.accounts.map((a) => a.name),
          cases: d.total,
          open: d.open,
          lastActivity: d.lastActivity,
        })),
        unattributed: {
          label: NO_DISTRICT,
          cases: noDistrict.total,
          note: "Cases whose account carries no NltDistrictCode — mostly higher-ed accounts.",
        },
      });
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "creatio_district_history",
  "Read one district's ticket history from the local index, newest first. Use this to " +
    "answer 'has this district reported this before?'. Pass the exact district code " +
    `from creatio_list_districts, or "${NO_DISTRICT}" for cases with no district code.`,
  {
    code: z.string().describe("District code, e.g. 'SMA-NC'."),
    q: z
      .string()
      .optional()
      .describe("Free-text filter over subject, case number, account and owner."),
    statuses: z
      .array(z.string())
      .optional()
      .describe("Only these exact status names. Omit for all statuses."),
    openOnly: z.boolean().optional().describe("Only tickets that are not in a terminal status."),
    limit: z.number().int().positive().optional().describe("Max rows (default 100)."),
    before: z
      .string()
      .optional()
      .describe("Page further back: only cases created before this ISO timestamp."),
  },
  async ({ code, q, statuses, openOnly, limit, before }) => {
    try {
      const ix = await peekDistrictIndex();
      if (!ix || !ix.cases.size) return ok(NOT_BUILT);
      const { rows, total, truncated } = districtHistory(ix, code, {
        q,
        statuses,
        before,
        limit: limit ?? 100,
      });
      const filtered = openOnly ? rows.filter((r) => isOpenStatus(r.status)) : rows;
      const tally: Record<string, number> = {};
      for (const r of filtered) tally[r.status] = (tally[r.status] || 0) + 1;
      return ok({
        code,
        window: { since: HISTORY_SINCE, complete: ix.complete },
        matched: total,
        returned: filtered.length,
        truncated,
        statusTally: tally,
        cases: filtered.map(slimRow),
        note:
          "Descriptions and conversation timelines are NOT in this index — fetch them " +
          "per case with creatio_query_records (Case Symptoms / SocialMessage / Activity).",
      });
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "creatio_case_district",
  "Look up which SIS district a case belongs to, by case number, plus where that " +
    "district code came from (the account record, or inferred from the ticket text).",
  {
    caseNumber: z.string().describe("Case number, e.g. 'SR00055921'."),
  },
  async ({ caseNumber }) => {
    try {
      const ix = await peekDistrictIndex();
      if (!ix || !ix.cases.size) return ok(NOT_BUILT);
      const row = caseByNumber(ix, caseNumber);
      if (!row) {
        return ok({
          caseNumber,
          found: false,
          message:
            `Not in the indexed window (from ${HISTORY_SINCE}${ix.complete ? "" : ", and the backfill is incomplete"}). ` +
            "Query it directly with creatio_query_records and expand Account($select=Name,NltDistrictCode).",
        });
      }
      const siblings = row.code
        ? districtHistory(ix, row.code, { limit: 1 }).total
        : 0;
      return ok({
        caseNumber: row.number,
        found: true,
        districtCode: row.code,
        codeSource: row.source,
        authoritative: row.source === "account",
        account: row.accountName,
        subject: row.subject,
        status: row.status,
        createdOn: row.createdOn,
        otherCasesForDistrict: siblings,
        statusesInIndex: statusesPresent(ix).length,
      });
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
