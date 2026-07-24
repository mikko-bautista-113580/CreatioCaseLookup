#!/usr/bin/env node
/**
 * Standalone auth check. Verifies the credentials in your .env actually work,
 * WITHOUT starting the MCP server.
 *
 *  - Forms mode (CREATIO_LOGIN/PASSWORD): runs the AuthService.svc/Login call.
 *  - Cookie mode (CREATIO_ASPXAUTH/BPMCSRF): does a tiny read-only OData GET to
 *    confirm the pasted browser session is still valid.
 *
 *   npm run test-auth
 *
 * Exit code 0 = works, 1 = doesn't (or config is missing).
 */

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`✖ Missing required env var: ${name}`);
    console.error(`  Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return v;
}

const BASE_URL = requireEnv("CREATIO_BASE_URL").replace(/\/+$/, "");
const ASPXAUTH = (process.env.CREATIO_ASPXAUTH ?? "").trim().replace(/^\.?ASPXAUTH=/i, "");
const BPMCSRF = (process.env.CREATIO_BPMCSRF ?? "").trim().replace(/^BPMCSRF=/i, "");
const BPMLOADER = (process.env.CREATIO_BPMLOADER ?? "").trim().replace(/^BPMLOADER=/i, "");
const COOKIE_MODE = Boolean(ASPXAUTH && BPMCSRF);

async function testCookies() {
  const entity = (process.env.CREATIO_ALLOWED_ENTITIES ?? "").split(",")[0]?.trim() || "Contact";
  console.error(`→ Cookie mode: validating session against ${BASE_URL} (reading 1 ${entity}) ...`);

  const cookie = [
    `.ASPXAUTH=${ASPXAUTH}`,
    `BPMCSRF=${BPMCSRF}`,
    BPMLOADER ? `BPMLOADER=${BPMLOADER}` : "",
  ].filter(Boolean).join("; ");

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/0/odata/${entity}?$top=1`, {
      method: "GET",
      headers: { Accept: "application/json", Cookie: cookie, BPMCSRF, ForceUseSession: "true" },
    });
  } catch (e) {
    console.error(`✖ Could not reach Creatio: ${e instanceof Error ? e.message : String(e)}`);
    console.error(`  Check CREATIO_BASE_URL and your network/VPN.`);
    process.exitCode = 1; return;
  }

  if (res.ok) {
    console.error(`✔ Success. The session cookies are valid — the MCP server can read with them.`);
    console.error(`  Reminder: these expire; re-grab from DevTools when reads start failing.`);
    process.exitCode = 0; return;
  }

  if (res.status === 401 || res.status === 403) {
    console.error(`✖ Cookies rejected (HTTP ${res.status}). The session is expired or invalid.`);
    console.error(`  Log into ${BASE_URL} again, re-copy .ASPXAUTH / BPMCSRF / BPMLOADER from`);
    console.error(`  DevTools → Application → Cookies, and update .env.`);
  } else {
    const text = await res.text().catch(() => "");
    console.error(`✖ Unexpected HTTP ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  }
  process.exitCode = 1; return;
}

async function testFormsLogin() {
  const LOGIN = requireEnv("CREATIO_LOGIN");
  const PASSWORD = requireEnv("CREATIO_PASSWORD");
  console.error(`→ Forms mode: logging in as "${LOGIN}" at ${BASE_URL} ...`);

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/ServiceModel/AuthService.svc/Login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ UserName: LOGIN, UserPassword: PASSWORD }),
    });
  } catch (e) {
    console.error(`✖ Could not reach Creatio: ${e instanceof Error ? e.message : String(e)}`);
    console.error(`  Check CREATIO_BASE_URL and your network/VPN.`);
    process.exitCode = 1; return;
  }

  const body = (await res.json().catch(() => ({}))) as { Code?: number; Message?: string };
  const setCookie = (res.headers as any).getSetCookie?.() as string[] | undefined;
  const gotBpmcsrf = (setCookie ?? []).some((c) => c.startsWith("BPMCSRF="));

  if (res.ok && body.Code === 0 && gotBpmcsrf) {
    console.error(`✔ Success. Forms auth works and a BPMCSRF cookie was issued.`);
    process.exitCode = 0; return;
  }

  console.error(`✖ Login failed. HTTP ${res.status} ${res.statusText}`);
  console.error(`  Code: ${body.Code ?? "(none)"}  Message: ${body.Message ?? "(none)"}`);
  if (body.Code && body.Code !== 0) {
    console.error(`  This usually means wrong credentials, OR the account is SSO-only /`);
    console.error(`  forms login is disabled. If so, use cookie mode instead.`);
  }
  process.exitCode = 1; return;
}

if (COOKIE_MODE) {
  await testCookies();
} else {
  await testFormsLogin();
}
