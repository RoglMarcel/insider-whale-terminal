"""Normalize only publicly observed financial figures. Amounts become full currency units.
No implicit zeros, no cross-provider mixing, no raw HTML/credentials in the published artifact.
"""
import calendar
import datetime as dt
import json
import math
import os
import re
import sys
import time
from pathlib import Path
from fetch import fetch, text

FIELDS = {
 'Revenue': ('revenue','currency'), 'Net Income Common': ('netIncome','currency'), 'Net Income': ('netIncome','currency'),
 'EPS (Diluted)': ('eps','perShare'), 'EBIT': ('ebit','currency'), 'EBITDA': ('ebitda','currency'), 'EBT': ('pretaxIncome','currency'), 'Income Tax Provision': ('incomeTax','currency'),
 'Cash and Short Term Investments': ('cash','currency'), 'Receivables': ('receivables','currency'), 'Inventory': ('inventory','currency'), 'Property, Plant, Equpment (Net)': ('ppe','currency'),
 'Total liabilities': ('liabilities','currency'), 'Common Equity (Total)': ('bookEquity','currency'), 'Shareholders Equity (Total)': ('totalEquity','currency'), 'Shares (Common)': ('shares','shares'), 'Total Debt': ('debt','currency'),
 'Operating Cash Flow': ('operatingCashFlow','currency'), 'Depreciation & Amortization': ('depreciation','currency'), 'Capital expenditures': ('capex','currency'), 'Repayment/Issuance of Debt (Net)': ('netBorrowing','currency'), 'Dividends Paid (Common)': ('dividendsPaid','currency'),
 'Accounts Receivable Change': ('receivableCashChange','currency'), 'Change in inventories': ('inventoryCashChange','currency'), 'Accounts Payable Change': ('payableCashChange','currency'), 'Change in other assets and liabilities': ('otherWorkingCashChange','currency'),
 'P/E ratio': ('pe','ratio'), 'P/S ratio': ('ps','ratio'), 'P/B ratio': ('pb','ratio'), 'EV/EBIT': ('evEbit','ratio'), 'EV/EBITDA': ('evEbitda','ratio'), 'EV/Sales': ('evSales','ratio'),
 # Stockrow's P/Operating CF row is not consistent with price divided by CFO/share; do not use it as a valuation multiple.
 'Shareholders Equity (Tangible)': ('tangibleEquity','currency'),
}

def number(value):
    value=value.strip().replace(',','').replace('$','').replace('×','')
    if not value or value in {'—','-','N/A','NM'}: return None
    negative=value.startswith('(') and value.endswith(')')
    if negative: value=value[1:-1]
    pct=value.endswith('%')
    if pct: value=value[:-1]
    if not re.fullmatch(r'[+-]?\d+(?:\.\d+)?', value):return None
    n=float(value)*(-1 if negative else 1)
    return n/100 if pct else n

def period(value):
    m=re.fullmatch(r"([A-Za-z]{3})\s*['’](\d{2})",value.strip())
    if not m:return None
    month=dt.datetime.strptime(m[1],'%b').month
    return f'20{m[2]}-{month:02d}' # preserve source month precision, never invent fiscal year-end day

def statement(page, kind):
    out={}
    tables=page.css('table')
    if not tables:return out
    headers=[text(c) for c in tables[0].css('thead tr').first.css('th,td')]
    periods=[period(h) for h in headers[1:]]
    if not periods or not periods[0]:return out
    body=text(page)
    if kind!='metrics-ratios' and 'In millions of $ except per-share values' not in body: return out
    for tr in tables[0].css('tbody tr'):
        cells=tr.css('th,td')
        if not cells:continue
        summary=cells[0].css('details summary').first
        label=text(summary) if summary else ''
        if label not in FIELDS:continue
        key,unit=FIELDS[label]
        values=[]
        for p,c in zip(periods,cells[1:]):
            n=number(text(c))
            if n is None or p is None:continue
            if unit in {'currency','shares'}:n*=1_000_000
            if key in {'capex','dividendsPaid'}:n=abs(n)
            values.append({'value':n,'period':p,'unit':unit})
        if values:out[key]=values
    return out

def derive(dataset):
    facts=dataset['facts'];p=dataset['statementDate']
    def add(key,value,unit):
        if math.isfinite(value):facts[key]={'value':value,'period':p,'unit':unit,'derived':True}
    def all_fields(*keys):return all(k in facts and facts[k]['period']==p for k in keys)
    def v(key):return facts[key]['value']
    if all_fields('incomeTax','pretaxIncome') and v('pretaxIncome')>0:
        tax=v('incomeTax')/v('pretaxIncome')
        if 0<=tax<1:add('taxRate',tax,'fraction')
    if all_fields('dividendsPaid','shares') and v('shares')>0:add('dividendPerShare',v('dividendsPaid')/v('shares'),'perShare')
    if all_fields('dividendsPaid','netIncome') and v('netIncome')>0:add('payoutRatio',v('dividendsPaid')/v('netIncome'),'fraction')
    wc=['receivableCashChange','inventoryCashChange','payableCashChange','otherWorkingCashChange']
    if all_fields(*wc):add('workingCapitalChange',-sum(v(k) for k in wc),'currency') # cash-flow changes have the opposite sign to reinvestment
    # Explicit balance equality proves there are no non-common book equity claims; never treat a missing row as zero.
    if all_fields('totalEquity','bookEquity') and abs(v('totalEquity')-v('bookEquity'))<.01:
        add('minority',0,'currency');add('preferred',0,'currency')
    if all_fields('bookEquity','debt','cash'):add('investedCapital',v('bookEquity')+v('debt')-v('cash'),'currency')
    if all_fields('tangibleEquity','bookEquity'):
        # Keep the combined deduction as reported; individual goodwill/intangible allocations are not invented.
        add('totalIntangibles',v('bookEquity')-v('tangibleEquity'),'currency')


def stockrow(ticker):
    base=f'https://stockrow.com/{ticker}'
    page=fetch(base)
    h1=page.css('h1').first
    if not h1 or ticker not in text(h1).split():raise ValueError('Ticker identity mismatch')
    annual={}
    for kind in ['income-statement','balance-sheet','cash-flow','metrics-ratios']:
        time.sleep(.4)
        try:annual.update(statement(fetch(base+'/'+kind+'/a-desc'),kind))
        except Exception:continue
    if not annual or 'eps' not in annual:raise ValueError('No identified annual statements')
    p=annual['eps'][0]['period']
    data={'ticker':ticker,'provider':'stockrow','url':base,'fetchedAt':dt.datetime.now(dt.timezone.utc).isoformat(),'currency':'USD','statementDate':p,'facts':{k:values[0] for k,values in annual.items() if values[0]['period']==p},'annual':annual}
    quote=page.css('.company-price').first
    if quote:
        q=number(text(quote).split()[0])
        date=quote.css('.company-price__as-of').first
        # Observed date, not the current request timestamp, is attached to the price.
        if q is not None and date:
            m=re.search(r'as of (\d{1,2}) ([A-Za-z]{3})',text(date))
            if m:
                now=dt.datetime.now(dt.timezone.utc); month=dt.datetime.strptime(m[2],'%b').month
                year=now.year-(month>now.month)
                data['price']=q;data['priceAsOf']=dt.date(year,month,int(m[1])).isoformat()
    for section in page.css('section.keystats__ratios'):
        # Only growth is reused from the current quote section; no mixing current amounts with older annual statements.
        t=text(section)
        m=re.search(r'Next 5Y EPS Growth\s+([\d.]+)%',t)
        if m:data['facts']['expectedEpsGrowth']={'value':float(m[1])/100,'period':data['fetchedAt'][:10],'unit':'fraction'}
    derive(data)
    return data


def gurufocus(ticker):
    url=f'https://www.gurufocus.com/stock/{ticker}/summary'
    page=fetch(url)
    # TTM earnings and analyst growth are visibly labeled in the public tables.
    # We retain observation-date precision rather than inventing a report date.
    observed=dt.datetime.now(dt.timezone.utc).date().isoformat();facts={}
    for tr in page.css('tr'):
        cells=tr.css('td')
        if len(cells)<3:continue
        link=cells[1].css('a::attr(href)').get() or ''
        if link==f'/term/eps-diluated/{ticker}':
            n=number(text(cells[2]))
            if n is not None:facts['eps']={'value':n,'period':'TTM observed '+observed,'unit':'perShare'}
        label=text(cells[1])
        if label=='Future 3-5Y EPS without NRI Growth Rate Estimate Industry Rank':
            n=number(text(cells[2]))
            if n is not None:facts['expectedEpsGrowth']={'value':n/100,'period':'forecast observed '+observed,'unit':'fraction'}
    if not facts:raise ValueError('No identified public earnings dataset')
    return {'ticker':ticker,'provider':'gurufocus','url':url,'fetchedAt':dt.datetime.now(dt.timezone.utc).isoformat(),'currency':'USD','statementDate':observed,'basis':'TTM observations; forecast growth excludes non-recurring items','facts':facts}


def macrotrends(ticker,url):
    page=fetch(url)
    # The public pages expose a historical JSON matrix in originalData. Parse JSON, never execute fetched JavaScript.
    m=re.search(r'var\s+originalData\s*=\s*(\[.*?\])\s*;',page.html_content,re.S)
    if not m:raise ValueError('No public historical matrix')
    matrix=json.loads(m[1]);annual={}
    for row in matrix:
        from scrapling.parser import Selector
        label=text(Selector(row.get('field_name','')))
        if label not in FIELDS:continue
        key,unit=FIELDS[label];values=[]
        for date,value in row.items():
            if not re.fullmatch(r'\d{4}-\d{2}-\d{2}',date):continue
            n=number(str(value))
            if n is None:continue
            if unit in {'currency','shares'}:n*=1_000_000
            values.append({'value':abs(n) if key=='capex' else n,'period':date[:7],'unit':unit})
        if values:annual[key]=sorted(values,key=lambda f:f['period'],reverse=True)
    if not annual:raise ValueError('No recognized public statements')
    p=max(v[0]['period'] for v in annual.values())
    data={'ticker':ticker,'provider':'macrotrends','url':url,'fetchedAt':dt.datetime.now(dt.timezone.utc).isoformat(),'currency':'USD','statementDate':p,'facts':{k:v[0] for k,v in annual.items() if v[0]['period']==p},'annual':annual}
    derive(data);return data


def main():
    signal_file=Path('public/data/signals.json'); signals=json.loads(signal_file.read_text()) if signal_file.exists() else []
    tickers=list(dict.fromkeys(s['ticker'] for s in signals if re.fullmatch(r'[A-Z][A-Z0-9.\-]{0,11}',s.get('ticker',''))))
    cache_path=Path('tmp/fundamentals-cache.json')
    try:cache=json.loads(cache_path.read_text())
    except Exception:cache={}
    stocks={};now=dt.datetime.now(dt.timezone.utc);budget=time.monotonic()+240
    # Authorized provider exports can supplement TIKR and other unavailable public data. Raw export files stay runner-only.
    import_dir=Path(os.environ.get('FUNDAMENTALS_IMPORT_DIR','tmp/fundamentals-imports'))
    for ticker in tickers:
        if ticker in cache:stocks[ticker]=[d for d in cache[ticker] if d.get('provider') != 'gurufocus']
        if time.monotonic()>budget:continue
        current=stocks.get(ticker,[])
        recent=any(d.get('provider')=='stockrow' and (now-dt.datetime.fromisoformat(d['fetchedAt'])).total_seconds()<7*86400 for d in current)
        if not recent:
            collected=[]
            for provider,fn in [('stockrow',stockrow)]:
                try:
                    data=fn(ticker);collected.append(data);print(f'{provider}: {ticker}: {len(data["facts"])} validated figures')
                except Exception:print(f'{provider}: {ticker}: no supported public dataset')
            # Only verified exact URLs, never made-up company slugs.
            urls=json.loads(os.environ.get('MACROTRENDS_URLS') or '{}')
            url=urls.get(ticker) or ('https://www.macrotrends.net/stocks/charts/AAPL/apple/financial-statements' if ticker=='AAPL' else None)
            if url:
                try:collected.append(macrotrends(ticker,url))
                except Exception:print(f'macrotrends: {ticker}: no supported public dataset')
            if collected:
                refreshed={d['provider'] for d in collected}
                stocks[ticker]=[d for d in stocks.get(ticker,[]) if d.get('provider') not in refreshed]+collected
        for provider in ['stockrow','tikr','macrotrends']:
            file=import_dir/provider/(ticker+'.json')
            if file.exists():
                try:
                    d=json.loads(file.read_text());d['provider']=provider;d['ticker']=ticker;d['_imported']=True
                    stocks[ticker]=[x for x in stocks.get(ticker,[]) if x['provider']!=provider]+[d]
                except Exception:print(f'{provider}: {ticker}: import unreadable')
    cache_path.parent.mkdir(parents=True,exist_ok=True);cache_path.write_text(json.dumps({t:[d for d in rows if d.get('provider') in {'stockrow','macrotrends'} and not d.get('_imported')] for t,rows in stocks.items()},allow_nan=False))
    # TS validation runs before any data is copied to the public artifact.
    Path('tmp/fundamentals-collected.json').write_text(json.dumps({'schemaVersion':1,'generatedAt':now.isoformat(),'stocks':stocks},allow_nan=False))

if __name__=='__main__':main()
