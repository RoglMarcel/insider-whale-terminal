"""Bounded public-HTML fetches. No login, captcha solving, proxies or credential output."""
import json
import sys
from urllib.parse import urlparse, urljoin
from scrapling.fetchers import Fetcher
from scrapling.parser import Selector

ALLOWED = {'openinsider.com', 'www.secform4.com', 'www.insider-monitor.com', 'stockrow.com', 'www.gurufocus.com', 'www.macrotrends.net', 'macrotrends.net', 'www.tikr.com', 'tikr.com'}

def fetch(url):
    parsed = urlparse(url)
    if parsed.scheme not in {'https', 'http'} or parsed.hostname not in ALLOWED or parsed.username or parsed.password:
        raise ValueError('Unsupported public source')
    page = Fetcher.get(url, timeout=20, retries=0, follow_redirects=False, stealthy_headers=False, headers={'User-Agent':'InsiderWhalePublicData/1.0'})
    if page.status != 200:
        raise ValueError('Source did not return a public page')
    if len(page.body) > 8_000_000:
        raise ValueError('Source page too large')
    return page

def text(node):
    return ' '.join(node.get_all_text().split())

def table(page, selectors, url):
    for selector in selectors:
        for el in page.css(selector):
            rows = el.css('tr')
            if not rows:
                continue
            head = el.css('thead tr').first or rows[0]
            headers = [text(n) for n in head.css('th, td')]
            data = []
            for tr in rows:
                cells = tr.css('td')
                if not cells or tr == head:
                    continue
                insider = tr.css('a[href*="/insider/"]::attr(href)').get() or ''
                filing = tr.css('a[href*="sec.gov"]::attr(href), a[href*="edgar"]::attr(href), a[href*="s.php?id="]::attr(href)').get() or ''
                data.append({'cells': [text(n) for n in cells], 'insiderUrl': urljoin(url, insider) if insider else '', 'filingUrl': urljoin(url, filing) if filing else ''})
            if data:
                return {'headers': headers, 'rows': data}
    raise ValueError('No readable source table')

if __name__ == '__main__':
    try:
        request = json.load(sys.stdin)
        page = fetch(request['url'])
        result = table(page, request['selectors'], request['url'])
        json.dump(result, sys.stdout)
    except Exception:
        print('Public source fetch or parsing failed', file=sys.stderr)
        sys.exit(1)
