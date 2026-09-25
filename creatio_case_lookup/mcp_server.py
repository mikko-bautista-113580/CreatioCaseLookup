"""Creatio read-only MCP server (stdio).

All Creatio access (auth, cookie handling, the GET-only HTTP path, the query
builder, and the entity allowlist) lives in creatio_client.py, which is shared
with the local web app. This file is just the MCP surface over it.

SAFETY MODEL — see creatio_client.py. In short: only HTTP GET is ever issued,
there are no write tools, an allowlist restricts reachable entities, and $top
is clamped. SSO cookies are re-read from `.env` on demand, so refreshing them
there takes effect on the next query with no restart.

Built on the low-level ``mcp.server.Server`` so the tool names, descriptions
and JSON input schemas are exactly what the TypeScript server (zod) publishes.
"""

from __future__ import annotations

import json
import re
import sys
from typing import Any

import anyio
import jsonschema
import mcp_types as types
from mcp.server import Server
from mcp.server.stdio import stdio_server

from .creatio_client import (
    ALLOWED_ENTITIES,
    BASE_URL,
    COOKIE_MODE,
    MAX_TOP,
    assert_entity_allowed,
    build_query,
    odata_get,
)

_DRAFT7 = "http://json-schema.org/draft-07/schema#"
_GUID_RE = re.compile(r"[0-9a-fA-F-]{36}")


def _ok(data: Any) -> types.CallToolResult:
    return types.CallToolResult(
        content=[types.TextContent(text=json.dumps(data, indent=2, ensure_ascii=False))]
    )


def _fail(err: BaseException | str) -> types.CallToolResult:
    msg = str(err) if isinstance(err, BaseException) else err
    return types.CallToolResult(is_error=True, content=[types.TextContent(text=f"Error: {msg}")])


# ---------------------------------------------------------------------------
# Tool definitions (schemas mirror zod-to-json-schema output of the TS server)
# ---------------------------------------------------------------------------
_STR_ARRAY = {"type": "array", "items": {"type": "string"}}

TOOLS: list[dict[str, Any]] = [
    {
        "name": "creatio_list_allowed_entities",
        "description": (
            "List the Creatio OData entity sets this server is permitted to read. "
            "If the allowlist is empty, all entities are readable."
        ),
        "inputSchema": {"$schema": _DRAFT7, "type": "object", "properties": {}},
    },
    {
        "name": "creatio_query_records",
        "description": (
            "Query records from a Creatio entity via OData (read-only GET). "
            "Use OData syntax for filter/orderby, e.g. filter: \"Number eq 'SR00042038'\"."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "entity": {"type": "string", "description": "OData entity set name, e.g. 'Case' or 'Contact'."},
                "select": {**_STR_ARRAY, "description": "Columns to return, e.g. ['Id','Number','Subject']."},
                "filter": {"type": "string", "description": "OData $filter expression."},
                "orderby": {"type": "string", "description": "OData $orderby, e.g. 'CreatedOn desc'."},
                "top": {
                    "type": "integer",
                    "exclusiveMinimum": 0,
                    "description": f"Max rows (clamped to {MAX_TOP}).",
                },
                "expand": {"type": "string", "description": "OData $expand for lookups, e.g. 'Owner'."},
            },
            "required": ["entity"],
            "additionalProperties": False,
            "$schema": _DRAFT7,
        },
    },
    {
        "name": "creatio_get_record",
        "description": "Fetch a single Creatio record by its GUID Id (read-only GET).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "entity": {"type": "string", "description": "OData entity set name, e.g. 'Case'."},
                "id": {
                    "type": "string",
                    "description": "Record GUID, e.g. 'f3ed4f55-894b-42bc-b5a1-f10b9d0bc03f'.",
                },
                "select": {**_STR_ARRAY, "description": "Columns to return."},
                "expand": {"type": "string", "description": "OData $expand for lookups."},
            },
            "required": ["entity", "id"],
            "additionalProperties": False,
            "$schema": _DRAFT7,
        },
    },
]
_BY_NAME = {t["name"]: t for t in TOOLS}


async def _list_allowed_entities(_args: dict[str, Any]) -> types.CallToolResult:
    return _ok(
        {
            "baseUrl": BASE_URL,
            "readOnly": True,
            "maxTop": MAX_TOP,
            "allowlist": ALLOWED_ENTITIES if ALLOWED_ENTITIES else "(none — all entities readable)",
        }
    )


async def _query_records(args: dict[str, Any]) -> types.CallToolResult:
    try:
        entity = args["entity"]
        assert_entity_allowed(entity)
        q = build_query(
            select=args.get("select"),
            filter=args.get("filter"),
            orderby=args.get("orderby"),
            top=args.get("top"),
            expand=args.get("expand"),
        )
        return _ok(await odata_get(entity + q))
    except Exception as e:  # noqa: BLE001 — reported to the client as a tool error
        return _fail(e)


async def _get_record(args: dict[str, Any]) -> types.CallToolResult:
    try:
        entity, id_ = args["entity"], args["id"]
        assert_entity_allowed(entity)
        if not _GUID_RE.fullmatch(id_):
            raise ValueError(f"Invalid GUID: {id_}")
        q = re.sub(r"^\?", "", build_query(select=args.get("select"), expand=args.get("expand"), top=1))
        path = f"{entity}({id_})" + (("?" + re.sub(r"&?\$top=\d+", "", q, count=1)) if q else "")
        return _ok(await odata_get(path))
    except Exception as e:  # noqa: BLE001
        return _fail(e)


_HANDLERS = {
    "creatio_list_allowed_entities": _list_allowed_entities,
    "creatio_query_records": _query_records,
    "creatio_get_record": _get_record,
}


async def _on_list_tools(_ctx: Any, _params: Any) -> types.ListToolsResult:
    return types.ListToolsResult(
        tools=[
            types.Tool(
                name=t["name"],
                description=t["description"],
                input_schema=t["inputSchema"],
                execution=types.ToolExecution(task_support="forbidden"),
            )
            for t in TOOLS
        ]
    )


async def _on_call_tool(_ctx: Any, params: types.CallToolRequestParams) -> types.CallToolResult:
    tool = _BY_NAME.get(params.name)
    if tool is None:
        return _fail(f"Tool {params.name} not found")
    args = dict(params.arguments or {})
    # zod validated the TS arguments; jsonschema does the same job here.
    errors = sorted(
        jsonschema.Draft7Validator(tool["inputSchema"]).iter_errors(args), key=lambda e: list(e.path)
    )
    if errors:
        detail = "; ".join(
            (f"{'/'.join(map(str, e.path))}: " if e.path else "") + e.message for e in errors
        )
        # Same envelope the TS SDK uses for a zod failure (the detail is
        # jsonschema's wording rather than zod's issue JSON).
        return types.CallToolResult(
            is_error=True,
            content=[
                types.TextContent(
                    text=f"MCP error -32602: Input validation error: Invalid arguments for tool {params.name}: {detail}"
                )
            ],
        )
    return await _HANDLERS[params.name](args)


server: Server = Server(
    "creatio-mcp-readonly",
    version="0.1.0",
    on_list_tools=_on_list_tools,
    on_call_tool=_on_call_tool,
)


# ---------------------------------------------------------------------------
# Boot
# ---------------------------------------------------------------------------
async def _serve() -> None:
    async with stdio_server() as (read_stream, write_stream):
        print(
            f"[creatio-mcp] read-only server ready. base={BASE_URL} "
            f"auth={'cookie(SSO)' if COOKIE_MODE else 'forms'} "
            f"allowlist=[{', '.join(ALLOWED_ENTITIES) or '*'}] maxTop={MAX_TOP}",
            file=sys.stderr,
            flush=True,
        )
        await server.run(read_stream, write_stream, server.create_initialization_options())


def main() -> None:
    try:
        sys.stderr.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    except (AttributeError, ValueError):
        pass
    try:
        anyio.run(_serve)
    except KeyboardInterrupt:
        pass
    except Exception as e:  # noqa: BLE001
        print(f"[creatio-mcp] fatal: {e!r}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
