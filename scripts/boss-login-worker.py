"""Private UI login worker for boss-agent-cli 3.0.1.

The official page owns QR creation, scan/confirm and cookies. Only the visible QR
image and a small state enum leave this process. Login and reading share the dedicated Chrome profile.
stdout is an internal JSON-lines pipe, never a user-facing log.
"""
import base64
from contextlib import suppress
import importlib.metadata
import json
import os
from pathlib import Path
import signal
import sys
import time


def emit(state, **fields):
    print(json.dumps({"state": state, **fields}, separators=(",", ":")), flush=True)


def login(data):
    from patchright.sync_api import sync_playwright
    from boss_browser import open_browser, ReaderError
    from boss_cdp import ChromeReader
    from boss_agent_cli.auth.manager import AuthManager
    from boss_agent_cli.auth.browser import (
        _raise_if_security_page, _is_cookie_domain, _safe_user_agent, _extract_stoken,
    )
    from boss_agent_cli.api.browser_urls import is_zhipin_url
    from boss_agent_cli.api.client import AccountRiskError, PlatformRiskError
    from boss_agent_cli.api.zhipin_errors import (
        platform_risk_page_response, raise_platform_risk_response,
    )

    data.mkdir(parents=True, exist_ok=True, mode=0o700)
    auth = AuthManager(data)
    try:
        auth._check_cdp_login_risk_lock(None)
        address = open_browser(data)
        selector = ChromeReader(data)
        try:
            target = selector.work_target()
        finally:
            selector.close()
        with sync_playwright() as pw:
            browser = pw.chromium.connect_over_cdp(address)
            try:
                context = browser.contexts[0]
                page = None
                for candidate in context.pages:
                    probe = context.new_cdp_session(candidate)
                    try:
                        info = probe.send('Target.getTargetInfo')['targetInfo']
                        if info['targetId'] == target:
                            page = candidate
                            break
                    finally:
                        probe.detach()
                if page is None:
                    raise ReaderError('BROWSER_SESSION_NOT_FOUND')
                # A successful prior login stays inside the same Chrome profile.
                if any(c["name"] == "wt2" and c["value"] for c in context.cookies("https://www.zhipin.com")):
                    (data / "chrome-session-ready").touch(mode=0o600)
                    emit("success")
                    return
                page.set_default_timeout(5000)
                risk = None
                login_ok = False
                blocked = False
                scanned = False

                def response_seen(response):
                    nonlocal risk, login_ok, blocked, scanned
                    if risk is not None or not is_zhipin_url(response.url):
                        return
                    if "/wapi/" not in response.url:
                        return
                    try:
                        try:
                            payload = response.json()
                        except Exception:
                            payload = None
                        if isinstance(payload, dict):
                            raise_platform_risk_response(payload)
                        else:
                            page_risk = platform_risk_page_response(
                                url=response.url,
                                content_type=response.headers.get("content-type", ""),
                                body=response.text(),
                            )
                            if page_risk:
                                raise_platform_risk_response(page_risk)
                        if response.status == 403:
                            raise AccountRiskError("Official verification required", details={"platform_code": None})
                        if response.status == 429:
                            blocked = True
                        if "/zppassport/qrcode/scan" in response.url and isinstance(payload, dict):
                            scanned = scanned or payload.get("scaned") is True
                        if any(path in response.url for path in (
                            "/zppassport/qrcode/dispatcher", "/zppassport/qrcode/loginConfirm",
                        )):
                            login_ok = isinstance(payload, dict) and payload.get("code") == 0
                            blocked = not login_ok
                    except PlatformRiskError as error:
                        risk = error
                    except Exception:
                        # A changed auth response must never become a successful login.
                        blocked = True

                page.on("response", response_seen)
                page.goto("https://www.zhipin.com/web/user/?mode=app", wait_until="domcontentloaded", timeout=30000)
                deadline = time.monotonic() + 300
                initial_deadline = time.monotonic() + 30
                last_src = ""
                emitted_scanned = False
                while time.monotonic() < deadline:
                    if risk is not None:
                        raise risk
                    _raise_if_security_page(page)
                    if blocked:
                        emit("error")
                        return
                    if login_ok:
                        page.wait_for_timeout(1500)
                        if risk is not None:
                            raise risk
                        _raise_if_security_page(page)
                        if not any(c["name"] == "wt2" and c["value"] for c in context.cookies("https://www.zhipin.com")):
                            raise RuntimeError("No authenticated session")
                        # Chrome stores its own session; never copy cookies to another context.
                        (data / "chrome-session-ready").touch(mode=0o600)
                        emit("success")
                        return
                    if scanned or page.locator(".scan-app-wrapper .login-step-box").is_visible():
                        if not emitted_scanned:
                            emit("scanned")
                            emitted_scanned = True
                    elif page.locator(".scan-app-wrapper .invalid-box button").is_visible():
                        emit("expired")
                        return
                    elif not emitted_scanned:
                        qr = page.locator(".scan-app-wrapper .qr-img-box img")
                        if qr.is_visible():
                            src = qr.get_attribute("src") or ""
                            if src and src != last_src and qr.evaluate("img => img.complete && img.naturalWidth > 0"):
                                png = qr.screenshot(type="png", timeout=5000)
                                if len(png) > 350000:
                                    raise RuntimeError("QR image too large")
                                emit("waiting", image="data:image/png;base64," + base64.b64encode(png).decode(), expiresAt=int(time.time() * 1000) + 30000)
                                last_src = src
                        elif not last_src and time.monotonic() > initial_deadline:
                            raise RuntimeError("Official QR element unavailable")
                    page.wait_for_timeout(400)
                emit("expired")
            finally:
                with suppress(Exception):
                    browser.close()  # Disconnect CDP; dedicated Chrome remains open.
    except PlatformRiskError as error:
        auth._record_cdp_risk_lock(None, error=error)
        emit("risk")


def main():
    os.umask(0o077)
    def stop(_signal, _frame):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, stop)
    try:
        if importlib.metadata.version("boss-agent-cli") != "3.0.1":
            raise RuntimeError("Unsupported runtime")
        from boss_browser import operation
        data = Path(sys.argv[1])
        with operation(data):
            login(data)
    except (KeyboardInterrupt, BrokenPipeError):
        pass
    except Exception:
        # Browser/network exceptions can contain auth data. Never serialize them.
        emit("error")


if __name__ == "__main__":
    main()
