/**
 * Interactive browser login — opens a real Chrome/Edge window on Creatio's
 * login page so the user authenticates normally (SSO / Windows auth / MFA),
 * then lifts the resulting .ASPXAUTH / BPMCSRF / BPMLOADER cookies straight
 * out of that browser's cookie jar. Replaces the manual "copy from DevTools"
 * step in Settings — the user still logs in themselves, we just stop making
 * them transcribe cookie values by hand.
 *
 * Uses playwright-core (no bundled browser download) against whichever of
 * Chrome/Edge is already installed on the machine, through a persistent
 * profile — so once you've signed in, reopening the login window reuses that
 * session (the browser just flashes open and closes) instead of forcing a
 * fresh sign-in every time.
 */
import { chromium, type BrowserContext } from "playwright-core";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export class LoginCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginCancelledError";
  }
}

const POLL_MS = 1000;
const TIMEOUT_MS = 5 * 60 * 1000; // give plenty of room for MFA prompts

// Sits next to .env (../.browser-profile relative to dist/browserLogin.js).
const PROFILE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", ".browser-profile");

async function launchContext(): Promise<BrowserContext> {
  const channels = ["chrome", "msedge"] as const;
  let lastErr: unknown;
  for (const channel of channels) {
    try {
      return await chromium.launchPersistentContext(PROFILE_DIR, { channel, headless: false });
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    "Could not launch a browser for login (tried Chrome and Edge). " +
      "Make sure Google Chrome or Microsoft Edge is installed. " +
      `Last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
  );
}

/**
 * Opens a browser window at `baseUrl` and waits for the user to finish logging
 * in, detected by the .ASPXAUTH cookie appearing in the jar. Resolves with the
 * three cookies Settings otherwise asks for by hand.
 *
 * `baseUrl` is passed in rather than read from the module-level BASE_URL
 * constant so a URL the user just saved in Settings works without a restart.
 */
export async function loginViaBrowser(
  baseUrl: string,
  onProgress: (message: string) => void
): Promise<{ aspx: string; csrf: string; loader: string }> {
  if (!baseUrl) {
    throw new Error("Creatio base URL is not configured (CREATIO_BASE_URL). Set it in Settings first.");
  }

  onProgress("Opening browser…");
  const context = await launchContext();

  let closedEarly = false;
  context.on("close", () => {
    closedEarly = true;
  });

  try {
    const page = context.pages()[0] || (await context.newPage());
    onProgress("Loading Creatio login…");
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    onProgress("Waiting for you to finish logging in…");

    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (closedEarly) {
        throw new LoginCancelledError("Login window was closed before sign-in completed.");
      }
      const cookies = await context.cookies(baseUrl);
      const aspx = cookies.find((c) => c.name === ".ASPXAUTH")?.value;
      const csrf = cookies.find((c) => c.name === "BPMCSRF")?.value;
      const loader = cookies.find((c) => c.name === "BPMLOADER")?.value;
      if (aspx && csrf) {
        onProgress("Signed in — capturing session…");
        return { aspx, csrf, loader: loader || "" };
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    throw new Error("Timed out waiting for login to complete.");
  } finally {
    if (!closedEarly) await context.close().catch(() => {});
  }
}
