import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
spec = importlib.util.spec_from_file_location('reader', Path(__file__).resolve().parents[1] / 'scripts/boss-reader.py')
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)
from boss_browser import ReaderError, check_lock, lock, operation

class ReaderTests(unittest.TestCase):
    def test_only_read_actions_and_strict_identifiers(self):
        for request in [
            {'name':'boss_greet','args':{}},
            {'name':'boss_detail','args':{'job_id':'../../foo'}},
            {'name':'boss_detail','args':{'job_id':'123','url':'https://evil.example'}},
            {'name':'boss_status','args':{'cookies':'secret'}},
            {'name':'boss_search','args':{'query':'AI','city':'西安','page':True}},
        ]:
            with self.assertRaises(ReaderError): reader.validate_request(request)
        self.assertEqual(reader.validate_request({'name':'boss_detail','args':{'job_id':'abc-123'}})[0], 'boss_detail')

    def test_font_digits_are_unknown_not_invented_salary(self):
        self.assertEqual(reader.clean_fields({'salary':'\ue031K','title':' 平台工程师 '}), {'salary':'','title':'平台工程师'})

    def test_risk_stop_and_concurrency_survive_another_process(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory)
            lock(data)
            with self.assertRaises(ReaderError): check_lock(data)
            with operation(data):
                with self.assertRaises(ReaderError):
                    with operation(data): pass

    def test_budget_does_not_silently_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory)
            reader.guard_budget(data)
            with self.assertRaises(ReaderError): reader.guard_budget(data)


class NativeCdpTests(unittest.TestCase):
    def test_existing_matching_search_uses_same_tab_without_navigation(self):
        from unittest.mock import patch
        class FakeReader:
            last_error = None
            calls = []
            def __init__(self, data): pass
            def targets(self): return [{'targetId':'same-profile-tab','url':'https://www.zhipin.com/web/geek/job?city=101110100&query=AI%20%E5%B9%B3%E5%8F%B0'}]
            def work_target(self, preferred=None): return preferred
            def attach(self, target): self.calls.append(('attach',target))
            def check_responses(self): pass
            def evaluate(self, expression):
                if expression == 'location.href': return self.targets()[0]['url']
                return [{'job_id':'test-only','title':'测试岗位','company':'测试公司'}] if expression == '(' + reader.LIST_JS + ')()' else None
            def call(self, method, params=None, **kwargs): self.calls.append((method,params)); raise AssertionError('must not navigate')
            def close(self): pass
        with tempfile.TemporaryDirectory() as directory, patch('boss_cdp.ChromeReader', FakeReader), patch('time.sleep'):
            result = reader.read(Path(directory), 'boss_search', {'query':'AI 平台','city':'西安','page':1})
            self.assertEqual(result['data'][0]['city'], '西安')
            self.assertEqual(FakeReader.calls, [('attach','same-profile-tab')])

    def test_platform_lock_prevents_cdp_connection(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory, patch('boss_cdp.ChromeReader') as chrome:
            data = Path(directory)
            lock(data)
            with self.assertRaises(ReaderError): reader.read(data,'boss_search',{'query':'AI','city':'西安'})
            chrome.assert_not_called()

    def test_cdp_http_limit_is_latched_and_not_treated_as_empty_jobs(self):
        from boss_cdp import ChromeReader
        with tempfile.TemporaryDirectory() as directory:
            cdp = object.__new__(ChromeReader)
            cdp.data, cdp.session = Path(directory), 'owned-session'
            with self.assertRaises(ReaderError) as raised:
                cdp.event({'sessionId':'owned-session','method':'Network.responseReceived','params':{'requestId':'r','response':{'url':'https://www.zhipin.com/wapi/zpgeek/search/joblist.json','status':429}}})
            self.assertEqual(raised.exception.code,'RATE_LIMITED')
            with self.assertRaises(ReaderError): check_lock(Path(directory))

    def test_evicted_response_body_does_not_abort_rendered_page_read(self):
        from boss_cdp import ChromeReader
        cdp = object.__new__(ChromeReader)
        cdp.responses, cdp.finished = {'evicted'}, {'evicted'}
        def missing(method, params): raise ReaderError('BOSS_BAD_RESPONSE')
        cdp.call = missing
        cdp.check_responses()
        self.assertFalse(cdp.responses)

    def test_short_security_navigation_is_detected_before_dom_can_redirect_home(self):
        from boss_cdp import ChromeReader
        with tempfile.TemporaryDirectory() as directory:
            cdp = object.__new__(ChromeReader)
            cdp.data, cdp.session = Path(directory), 'owned-session'
            with self.assertRaises(ReaderError) as raised:
                cdp.event({'sessionId':'owned-session','method':'Network.requestWillBeSent',
                    'params':{'type':'Document','request':{'url':'https://www.zhipin.com/web/passport/zp/security.html?seed=do-not-log'}}})
            self.assertEqual(raised.exception.code, 'BOSS_SECURITY_CHECK')
            self.assertEqual(cdp.navigations, ['/web/passport/zp/security.html'])
            self.assertNotIn('do-not-log', (Path(directory)/'cdp_risk_lock.json').read_text())
            with self.assertRaises(ReaderError) as persisted: check_lock(Path(directory))
            self.assertEqual(persisted.exception.code, 'BOSS_SECURITY_CHECK')

    def test_redirected_homepage_and_blank_login_tab_are_reused_across_processes(self):
        from boss_cdp import ChromeReader
        from boss_browser import saved_target
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory)
            cdp = object.__new__(ChromeReader)
            cdp.data = data
            def no_new_tab(*args, **kwargs): raise AssertionError('must not create a second tab')
            cdp.call = no_new_tab
            cdp.targets = lambda **kwargs: [{'targetId':'initial','url':'about:blank'}]
            self.assertEqual(cdp.work_target(), 'initial')
            # The same target has navigated/redirected since the next process starts.
            cdp.targets = lambda **kwargs: [{'targetId':'other','url':'https://www.zhipin.com/'},
                {'targetId':'initial','url':'https://www.zhipin.com/'}]
            self.assertEqual(cdp.work_target(), 'initial')
            # A closed tab's stale ID must not navigate an unrelated page.
            self.assertIsNone(saved_target(data, [{'targetId':'initial','url':'https://example.com/'}]))
            self.assertEqual((data/'browser-target').stat().st_mode & 0o777, 0o600)

    def test_new_tab_only_when_dedicated_profile_has_no_eligible_page(self):
        from boss_cdp import ChromeReader
        with tempfile.TemporaryDirectory() as directory:
            cdp = object.__new__(ChromeReader)
            cdp.data = Path(directory)
            cdp.targets = lambda **kwargs: []
            calls = []
            def call(method, args, **kwargs):
                calls.append((method,args))
                return {'targetId':'new-worker'}
            cdp.call = call
            self.assertEqual(cdp.work_target(), 'new-worker')
            self.assertEqual(calls, [('Target.createTarget', {'url':'about:blank','background':True})])

    def test_wrong_city_redirect_is_not_labelled_as_xian(self):
        from unittest.mock import patch
        class WrongCity:
            last_error = None
            def __init__(self, data): pass
            def targets(self): return [{'targetId':'owned','url':'https://www.zhipin.com/web/geek/jobs?city=101110100&query=AI'}]
            def work_target(self, preferred=None): return 'owned'
            def attach(self, target): pass
            def check_responses(self): pass
            def evaluate(self, expression):
                if expression == 'location.href': return 'https://www.zhipin.com/web/geek/jobs?city=101010100&query=AI'
                if expression == '(' + reader.LIST_JS + ')()': return [{'job_id':'test','title':'测试','company':'测试'}]
                return None
            def close(self): pass
        with tempfile.TemporaryDirectory() as directory, patch('boss_cdp.ChromeReader', WrongCity), patch('time.sleep'):
            with self.assertRaises(ReaderError) as e: reader.read(Path(directory),'boss_search',{'query':'AI','city':'西安'})
            self.assertEqual(e.exception.code, 'SEARCH_CONTEXT_CHANGED')

if __name__ == '__main__': unittest.main()
