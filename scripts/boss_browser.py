"""Dedicated, persistent Chrome session. No cookie export or default-profile access."""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
from urllib.request import urlopen
from urllib.parse import urlparse


class ReaderError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def endpoint(data):
    try:
        lines = (data / 'chrome-profile' / 'DevToolsActivePort').read_text().splitlines()
        port = int(lines[0])
        if not 1024 <= port <= 65535 or not lines[1].startswith('/devtools/browser/'):
            return None
        url = f'http://127.0.0.1:{port}'
        with urlopen(url + '/json/version', timeout=1) as response:
            value = json.loads(response.read(16384))
        # A stale port must never attach to some other browser.
        if urlparse(value.get('webSocketDebuggerUrl', '')).path != lines[1]:
            return None
        return url
    except Exception:
        return None


def chrome_binary():
    candidates = [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        str(Path(os.environ.get('PROGRAMFILES', '')) / 'Google/Chrome/Application/chrome.exe'),
        shutil.which('google-chrome'), shutil.which('google-chrome-stable'),
    ]
    return next((p for p in candidates if p and Path(p).is_file()), None)


def open_browser(data, official=False):
    data.mkdir(parents=True, exist_ok=True, mode=0o700)
    profile = data / 'chrome-profile'
    profile.mkdir(mode=0o700, exist_ok=True)
    profile.chmod(0o700)
    current = endpoint(data)
    binary = chrome_binary()
    if not binary:
        raise ReaderError('CHROME_REQUIRED')
    url = 'https://www.zhipin.com/' if official else 'about:blank'
    if not current:
        subprocess.Popen([binary, '--remote-debugging-address=127.0.0.1',
                          '--remote-debugging-port=0', f'--user-data-dir={profile}',
                          '--no-first-run', '--no-default-browser-check', '--start-minimized', url],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True)
    for _ in range(50):
        current = endpoint(data)
        if current:
            if official:
                # An owner-requested verification handoff reveals the existing tab.
                # Relaunching Chrome with a URL would create another homepage every time.
                from boss_cdp import ChromeReader
                reader = ChromeReader(data)
                try:
                    target = reader.work_target()
                    window = reader.call('Browser.getWindowForTarget', {'targetId': target}, browser=True)
                    reader.call('Browser.setWindowBounds', {'windowId': window['windowId'], 'bounds': {'windowState': 'normal'}}, browser=True)
                    reader.call('Target.activateTarget', {'targetId': target}, browser=True)
                finally:
                    reader.close()
            return current
        time.sleep(.2)
    raise ReaderError('BROWSER_SESSION_NOT_FOUND')


def check_lock(data):
    if (data / 'cdp_risk_lock.json').exists():
        try:
            if json.loads((data / 'cdp_risk_lock.json').read_text()).get('reason') == 'BOSS_SECURITY_CHECK':
                raise ReaderError('BOSS_SECURITY_CHECK')
        except (OSError, ValueError, AttributeError):
            pass
        raise ReaderError('ENVIRONMENT_RISK_LOCKED')


def lock(data, code='RISK_CONTROL'):
    data.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = data / 'cdp_risk_lock.json'
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps({'reason': code, 'locked_at': time.time(), 'platform_code': None}))
    temporary.chmod(0o600)
    temporary.replace(path)


def saved_target(data, targets, preferred=None):
    """Only the dedicated profile's BOSS/blank tabs can become the shared worker."""
    eligible = [t for t in targets if t.get('url') == 'about:blank'
                or urlparse(t.get('url', '')).hostname == 'www.zhipin.com']
    try:
        saved = (data / 'browser-target').read_text().strip()
    except OSError:
        saved = None
    for candidate in (preferred, saved):
        if any(t['targetId'] == candidate for t in eligible):
            return candidate
    return next((t['targetId'] for t in eligible if t['url'] != 'about:blank'),
                eligible[0]['targetId'] if eligible else None)


def remember_target(data, target):
    path = data / 'browser-target'
    path.write_text(target)
    path.chmod(0o600)


@contextmanager
def operation(data):
    # Single local account operation across login/search processes, including cancellation.
    import fcntl
    data.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (data / 'browser-operation.lock').open('a') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ReaderError('BOSS_BUSY')
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


if __name__ == '__main__':
    os.umask(0o077)
    try:
        data = Path(sys.argv[1])
        with operation(data):
            open_browser(data, official=True)
        print('{"ok":true}')
    except Exception:
        print('{"ok":false}')
        sys.exit(1)
