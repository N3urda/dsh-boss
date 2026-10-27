"""Bounded native CDP reader for our dedicated Chrome, with platform response guards."""
import json
from pathlib import Path
from urllib.parse import urlparse
from websockets.sync.client import connect
from boss_browser import ReaderError, endpoint, lock, saved_target, remember_target

class ChromeReader:
    def __init__(self, data):
        address = endpoint(data)
        if not address:
            raise ReaderError('BROWSER_SESSION_NOT_FOUND')
        path = (data / 'chrome-profile' / 'DevToolsActivePort').read_text().splitlines()[1]
        self.socket = connect(address.replace('http:', 'ws:') + path, proxy=None,
                              open_timeout=5, close_timeout=2, max_size=4*1024*1024)
        self.data = data
        self.number = 0
        self.session = None
        self.last_error = None
        self.responses = set()
        self.finished = set()
        self.navigations = []

    def event(self, message):
        if message.get('sessionId') != self.session:
            return
        event, params = message.get('method'), message.get('params', {})
        if event == 'Network.requestWillBeSent' and params.get('type') == 'Document':
            url = urlparse(params.get('request', {}).get('url', ''))
            if url.hostname == 'www.zhipin.com':
                # Keep only public paths, never query tokens or request headers.
                self.navigations = (getattr(self, 'navigations', []) + [url.path])[-12:]
                if url.path == '/web/passport/zp/security.html':
                    lock(self.data, 'BOSS_SECURITY_CHECK')
                    raise ReaderError('BOSS_SECURITY_CHECK')
        if event == 'Network.responseReceived':
            response = params.get('response', {})
            url = urlparse(response.get('url', ''))
            if url.hostname != 'www.zhipin.com' or not url.path.startswith('/wapi/'):
                return
            if response.get('status') in (403, 429):
                code = 'RATE_LIMITED' if response['status'] == 429 else 'RISK_CONTROL'
                lock(self.data, code)
                raise ReaderError(code)
            if 'json' in response.get('mimeType', ''):
                self.responses.add(params['requestId'])
        elif event == 'Network.loadingFinished':
            self.finished.add(params.get('requestId'))

    def call(self, method, params=None, browser=False):
        self.number += 1
        number = self.number
        request = {'id': number, 'method': method, 'params': params or {}}
        if self.session and not browser:
            request['sessionId'] = self.session
        self.socket.send(json.dumps(request))
        while True:
            message = json.loads(self.socket.recv(timeout=10))
            self.event(message)
            if message.get('id') == number:
                if 'error' in message:
                    self.last_error = {'method': method, 'code': message['error'].get('code')}
                    raise ReaderError('BOSS_BAD_RESPONSE')
                return message.get('result', {})

    def targets(self, include_blank=False):
        return [t for t in self.call('Target.getTargets', browser=True).get('targetInfos', [])
                if t.get('type') == 'page' and (urlparse(t.get('url', '')).hostname == 'www.zhipin.com'
                or (include_blank and t.get('url') == 'about:blank'))]

    def work_target(self, preferred=None):
        target = saved_target(self.data, self.targets(include_blank=True), preferred)
        if target is None:
            target = self.call('Target.createTarget', {'url': 'about:blank', 'background': True}, browser=True)['targetId']
        remember_target(self.data, target)
        return target

    def attach(self, target):
        self.session = self.call('Target.attachToTarget', {'targetId': target, 'flatten': True}, browser=True)['sessionId']
        self.call('Page.enable')
        self.call('Runtime.enable')
        self.call('Network.enable', {'maxTotalBufferSize': 4*1024*1024,
                                    'maxResourceBufferSize': 2*1024*1024,
                                    'enableDurableMessages': True})

    def evaluate(self, expression):
        value = self.call('Runtime.evaluate', {'expression': expression, 'returnByValue': True, 'awaitPromise': True})
        if value.get('exceptionDetails'):
            raise ReaderError('BOSS_BAD_RESPONSE')
        return value.get('result', {}).get('value')

    def check_responses(self):
        from boss_agent_cli.api.zhipin_errors import raise_platform_risk_response
        from boss_agent_cli.api.client import PlatformRiskError
        for request in list(self.responses & self.finished):
            self.responses.discard(request)
            self.finished.discard(request)
            try:
                body = self.call('Network.getResponseBody', {'requestId': request})
                if not body.get('base64Encoded') and len(body.get('body', '')) < 2*1024*1024:
                    payload = json.loads(body.get('body', '{}'))
                    if isinstance(payload, dict): raise_platform_risk_response(payload)
            except PlatformRiskError:
                lock(self.data)
                raise ReaderError('RISK_CONTROL')
            except ReaderError as error:
                if error.code != 'BOSS_BAD_RESPONSE': raise
                # Chrome may evict a finished response; the rendered page guard still runs.
                continue
            except (ValueError, KeyError):
                pass

    def close(self):
        self.socket.close()
