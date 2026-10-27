"""Read-only DOM adapter over the dedicated Chrome used for QR login.

The local MCP exposes search/detail/status only. No platform write endpoints,
private API calls, captcha handling, cookie injection or browser fallback.
"""
import json
import os
from pathlib import Path
import re
import sys
import time
from urllib.parse import urlencode, urlparse
from boss_browser import ReaderError, endpoint, check_lock, lock, operation

# Selector knowledge checked against BossHunter's BOSS collector (2026-10-27).
# Independently implemented; read only public fields, never HR identity/contact.
DIAGNOSTIC = {'stage': 'start'}

LIST_JS = """() => [...document.querySelectorAll('.job-card-wrap')].map(card => {
  const text = selector => card.querySelector(selector)?.textContent?.trim() || '';
  const anchor = card.querySelector('a.job-name, a[href*="/job_detail/"]');
  const href = anchor?.getAttribute('href') || '';
  const id = href.match(/\\/job_detail\\/([A-Za-z0-9_-]+)\\.html/);
  const tags = [...card.querySelectorAll('.tag-list li')].map(n => n.textContent.trim());
  return {job_id: id?.[1] || '', title: text('.job-name'),
    company: text('.company-name') || text('.boss-name'), salary: text('.job-salary'),
    district: text('.company-location'), experience: tags[0] || '', education: tags[1] || ''};
})"""
DETAIL_JS = """() => {
  const text = selector => document.querySelector(selector)?.textContent?.trim() || '';
  return {title: text('.info-primary .name h1') || text('.name h1'),
    company: text('.sider-company .company-info a'), salary: text('.info-primary .salary'),
    description: text('.job-sec-text'), address: text('.job-location .location-address') || text('.location-address'),
    experience: text('.info-primary .tag-list span:first-child'),
    education: text('.info-primary .tag-list span:nth-child(2)')};
}"""
RISK_JS = """() => {
 const shown = n => n && n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden';
 const captcha = [...document.querySelectorAll('[class*="captcha"],[id*="captcha"],.geetest_panel,iframe[src*="verify"]')].some(shown);
 const body = document.body?.innerText || '';
 const content = document.querySelector('.job-card-wrap,.job-sec-text');
 if(location.pathname === '/web/passport/zp/security.html') return 'BOSS_SECURITY_CHECK';
 if(captcha || /security-check|\\/verify|captcha/.test(location.pathname)) return 'RISK_CONTROL';
 if(!content && /安全验证|完成验证|访问被拒绝|账号异常|当前访问环境/.test(body)) return 'RISK_CONTROL';
 if(!content && /操作频繁|访问频繁|请求频繁/.test(body)) return 'RATE_LIMITED';
 if(!content && /\\/web\\/user/.test(location.pathname)) return 'AUTH_REQUIRED';
 return null;
}"""


def clean_fields(value):
    # A private-use font is not safely readable as text. Never guess salary digits.
    return {k: ('' if re.search(r'[\ue000-\uf8ff]', v) else v.strip())
            for k, v in value.items() if isinstance(v, str)}


def validate_request(value):
    if not isinstance(value, dict) or set(value) != {'name', 'args'}:
        raise ReaderError('INVALID_PARAM')
    name, args = value['name'], value['args']
    if name not in ('boss_status', 'boss_search', 'boss_detail') or not isinstance(args, dict):
        raise ReaderError('FORBIDDEN')
    if name == 'boss_search':
        if set(args) - {'city', 'query', 'page'} or not isinstance(args.get('query'), str) or not 1 <= len(args['query'].strip()) <= 100:
            raise ReaderError('INVALID_PARAM')
        if not isinstance(args.get('city'), str) or len(args['city']) > 50:
            raise ReaderError('INVALID_PARAM')
        if type(args.get('page', 1)) is not int or not 1 <= args.get('page', 1) <= 10:
            raise ReaderError('INVALID_PARAM')
    elif name == 'boss_detail':
        if set(args) != {'job_id'} or not isinstance(args['job_id'], str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,256}', args['job_id']):
            raise ReaderError('INVALID_PARAM')
    elif args:
        raise ReaderError('INVALID_PARAM')
    return name, args


def guard_budget(data):
    path = data / 'reader-budget.json'
    today = time.strftime('%Y-%m-%d')
    old = json.loads(path.read_text()) if path.exists() else {}
    if old.get('day') == today and old.get('count', 0) >= 60:
        raise ReaderError('DAILY_LIMIT')
    if time.time() - old.get('at', 0) < 3:
        raise ReaderError('RATE_LIMITED')
    path.write_text(json.dumps({'day': today, 'count': old.get('count', 0) + 1 if old.get('day') == today else 1, 'at': time.time()}))
    path.chmod(0o600)


def read(data, name, args):
    from boss_cdp import ChromeReader
    from boss_agent_cli.api.endpoints import CITY_CODES
    from urllib.parse import quote, parse_qs
    check_lock(data)
    DIAGNOSTIC['stage'] = 'session'
    reader = ChromeReader(data)
    try:
        targets = reader.targets()
        if name == 'boss_status':
            DIAGNOSTIC['paths'] = [urlparse(t['url']).path for t in targets]
            # Status reads the dedicated browser's current authenticated page, without navigation.
            logged = False
            if targets:
                reader.attach(targets[-1]['targetId'])
                logged = bool(reader.evaluate("Boolean(document.querySelector('.is-login'))"))
            return {'ok': True, 'data': {'logged_in': logged}}
        guard_budget(data)
        city = args.get('city', '')
        page_number = args.get('page', 1)
        if name == 'boss_search':
            city_code = CITY_CODES.get(city)
            if not city_code: raise ReaderError('INVALID_PARAM')
            url = 'https://www.zhipin.com/web/geek/job?' + urlencode({'query': args['query'], 'city': city_code}, quote_via=quote)
            def matches(target):
                parsed = urlparse(target.get('url', ''))
                query = parse_qs(parsed.query)
                return parsed.path in ('/web/geek/job', '/web/geek/jobs') and query.get('city') == [city_code] and query.get('query') == [args['query']]
            existing = next((t for t in targets if matches(t)), None)
        else:
            url = f'https://www.zhipin.com/job_detail/{args["job_id"]}.html'
            existing = next((t for t in targets if t.get('url', '').split('?')[0] == url), None)
        if page_number > 1 and not existing: raise ReaderError('PAGINATION_UNAVAILABLE')
        DIAGNOSTIC['stage'] = 'navigate'
        target = reader.work_target(existing['targetId'] if existing else None)
        reader.attach(target)
        before = 0
        if not existing:
            reader.call('Page.navigate', {'url': url})
        elif page_number > 1:
            before = reader.evaluate("document.querySelectorAll('.job-card-wrap').length") or 0
            reader.call('Input.dispatchMouseEvent', {'type':'mouseWheel','x':600,'y':500,'deltaX':0,'deltaY':4500})
        DIAGNOSTIC['stage'] = 'read_page'
        deadline = time.monotonic() + 22
        while time.monotonic() < deadline:
            time.sleep(.4)
            reader.check_responses()
            try:
                code = reader.evaluate('(' + RISK_JS + ')()')
                if code:
                    if code in ('RISK_CONTROL', 'RATE_LIMITED', 'BOSS_SECURITY_CHECK'): lock(data, code)
                    raise ReaderError(code)
                if name == 'boss_search':
                    jobs = reader.evaluate('(' + LIST_JS + ')()') or []
                    if len(jobs) > before:
                        jobs = [clean_fields(j) for j in jobs]
                        DIAGNOSTIC.update({'stage':'parse_cards','cards':len(jobs)})
                        if any(not j.get('job_id') or not j.get('title') or not j.get('company') for j in jobs):
                            raise ReaderError('BOSS_BAD_RESPONSE')
                        # The site can change city/keyword in a redirect. Never label a
                        # Beijing/recommendation list as the requested Xi'an search.
                        context = reader.evaluate('location.href')
                        if not context or not matches({'url': context}):
                            raise ReaderError('SEARCH_CONTEXT_CHANGED')
                        for job in jobs: job['city'] = city
                        return {'ok': True, 'data': jobs[:100]}
                else:
                    job = clean_fields(reader.evaluate('(' + DETAIL_JS + ')()') or {})
                    if job.get('title') and job.get('description'):
                        job['job_id'] = args['job_id']
                        return {'ok': True, 'data': job}
            except ReaderError as e:
                # A changing execution context is allowed to settle; risk stops immediately.
                if e.code != 'BOSS_BAD_RESPONSE': raise
        path = reader.evaluate('location.pathname')
        DIAGNOSTIC['path'] = path
        if path == '/': raise ReaderError('BOSS_SEARCH_REDIRECTED')
        raise ReaderError('PAGINATION_UNAVAILABLE' if page_number > 1 else 'BOSS_BAD_RESPONSE')
    finally:
        if reader.last_error: DIAGNOSTIC['cdp_error'] = reader.last_error
        if getattr(reader, 'navigations', None): DIAGNOSTIC['navigations'] = reader.navigations
        reader.close()


def main():
    os.umask(0o077)
    try:
        name, args = validate_request(json.loads(sys.stdin.read(16384)))
        data = Path(sys.argv[1])
        with operation(data):
            result = read(data, name, args)
    except ReaderError as e:
        DIAGNOSTIC['error'] = e.code
        result = {'ok': False, 'error': {'code': e.code}}
    except Exception as e:
        DIAGNOSTIC['exception'] = type(e).__name__
        DIAGNOSTIC['categories'] = [k for k in ('SyntaxError', 'ReferenceError', 'TypeError', 'Execution context was destroyed', 'Target closed', 'Target page', 'Cannot find context', 'Content Security Policy', 'Page.evaluate', 'Timeout', 'Runtime.callFunctionOn', 'Object reference chain is too long', 'unexpected token', 'getClientRects', 'getComputedStyle') if k.lower() in str(e).lower()]
        result = {'ok': False, 'error': {'code': 'BOSS_UNAVAILABLE'}}
    try:
        audit = Path(sys.argv[1]) / 'reader-last.json'
        if name != 'boss_status' and not (audit.exists() and DIAGNOSTIC.get('stage') == 'start'):
            audit.write_text(json.dumps(DIAGNOSTIC))
            audit.chmod(0o600)
    except Exception:
        pass
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
