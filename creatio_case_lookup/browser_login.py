"""Interactive browser login — opens a real Chrome/Edge window on Creatio's
login page so the user authenticates normally (SSO / Windows auth / MFA),
then lifts the resulting .ASPXAUTH / BPMCSRF / BPMLOADER cookies straight
out of that browser's cookie jar. Replaces the manual "copy from DevTools"
step in Settings — the user still logs in themselves, we just stop making
them transcribe cookie values by hand.

Uses Playwright (no bundled browser download needed) against whichever of
Chrome/Edge is already installed on the machine, through a persistent
profile — so once you've signed in, reopening the login window reuses that
session (the browser just flashes open and closes) instead of forcing a
fresh sign-in every time.

Playwright is imported lazily inside the function, so the rest of the app
runs without it installed — only this login path stops working.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from typing import Any

from .paths import PROFILE_DIR


class LoginCancelledError(Exception):
    pass


POLL_S = 1.0
TIMEOUT_S = 5 * 60  # give plenty of room for MFA prompts


async def _launch_context(chromium: Any) -> Any:
    last_err: BaseException | None = None
    for channel in ("chrome", "msedge"):
        try:
            return await chromium.launch_persistent_context(
                str(PROFILE_DIR), channel=channel, headless=False
            )
        except Exception as e:  # noqa: BLE001 — try the next channel
            last_err = e
    msg = getattr(last_err, "message", None) or str(last_err)
    raise RuntimeError(
        "Could not launch a browser for login (tried Chrome and Edge). "
        "Make sure Google Chrome or Microsoft Edge is installed. "
        f"Last error: {msg}"
    )


async def login_via_browser(base_url: str, on_progress: Callable[[str], None]) -> dict[str, str]:
    """Open a browser window at `base_url` and wait for the user to finish
    logging in, detected by the .ASPXAUTH cookie appearing in the jar. Returns
    ``{"aspx", "csrf", "loader"}`` — the three cookies Settings otherwise asks
    for by hand.

    `base_url` is passed in rather than read from creatio_client.BASE_URL so a
    URL the user just saved in Settings works without a restart.
    `on_progress` is a plain sync callable receiving user-facing messages.
    """
    if not base_url:
        raise ValueError(
            "Creatio base URL is not configured (CREATIO_BASE_URL). Set it in Settings first."
        )

    try:
        from playwright.async_api import async_playwright
    except ImportError as e:  # pragma: no cover - depends on the environment
        raise RuntimeError(
            "Browser login needs Playwright. Install it with: pip install playwright"
        ) from e

    on_progress("Opening browser…")
    pw = await async_playwright().start()
    try:
        context = await _launch_context(pw.chromium)

        closed_early = False

        def _on_close(*_: Any) -> None:
            nonlocal closed_early
            closed_early = True

        context.on("close", _on_close)

        try:
            page = context.pages[0] if context.pages else await context.new_page()
            on_progress("Loading Creatio login…")
            await page.goto(base_url, wait_until="domcontentloaded")
            on_progress("Waiting for you to finish logging in…")

            deadline = time.monotonic() + TIMEOUT_S
            while time.monotonic() < deadline:
                if closed_early:
                    raise LoginCancelledError("Login window was closed before sign-in completed.")
                try:
                    cookies = await context.cookies(base_url)
                except Exception:
                    # The window closed mid-read; report it as a cancel, not a crash.
                    if closed_early:
                        raise LoginCancelledError(
                            "Login window was closed before sign-in completed."
                        ) from None
                    raise

                def val(name: str) -> str | None:
                    return next((c.get("value") for c in cookies if c.get("name") == name), None)

                aspx, csrf, loader = val(".ASPXAUTH"), val("BPMCSRF"), val("BPMLOADER")
                if aspx and csrf:
                    on_progress("Signed in — capturing session…")
                    return {"aspx": aspx, "csrf": csrf, "loader": loader or ""}
                await asyncio.sleep(POLL_S)
            raise TimeoutError("Timed out waiting for login to complete.")
        finally:
            if not closed_early:
                try:
                    await context.close()
                except Exception:  # noqa: BLE001
                    pass
    finally:
        try:
            await pw.stop()
        except Exception:  # noqa: BLE001
            pass
