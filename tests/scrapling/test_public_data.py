import importlib.util
import json
import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts/scrapling'))
from scrapling.parser import Selector
from fetch import table, fetch
from fundamentals import number,statement,derive

class PublicDataTests(unittest.TestCase):
 def test_money_missing_and_negative(self):
  self.assertEqual(number('(1,200.50)'),-1200.5)
  self.assertEqual(number('12.5%'),.125)
  self.assertIsNone(number('—'))
  self.assertIsNone(number('login required'))
 def test_keeps_insider_and_filing_links(self):
  p=Selector('<table class="tinytable"><thead><tr><th>Ticker</th><th>Name</th></tr></thead><tbody><tr><td>AAPL</td><td><a href="/insider/a/123">Person</a><a href="https://www.sec.gov/filing">Filing</a></td></tr></tbody></table>')
  d=table(p,['table.tinytable'],'http://openinsider.com/')
  self.assertEqual(d['headers'],['Ticker','Name'])
  self.assertEqual(len(d['rows']),1)
  self.assertEqual(d['rows'][0]['insiderUrl'],'http://openinsider.com/insider/a/123')
  self.assertEqual(d['rows'][0]['filingUrl'],'https://www.sec.gov/filing')
 def test_static_request_boundaries(self):
  for url in ['file:///etc/passwd','https://127.0.0.1/','https://secret@stockrow.com/AAPL','https://example.com/']:
   with self.assertRaises(ValueError):fetch(url)
 def test_statement_ignores_missing_values_and_tooltip_text(self):
  page=Selector('''<p>In millions of $ except per-share values</p><table><thead><tr><th></th><th>Sep '25</th><th>Sep '24</th></tr></thead><tbody><tr><td><details><summary>EPS (Diluted)</summary><span>Hidden tooltip</span></details></td><td>7.46</td><td>—</td></tr><tr><td><details><summary>Revenue</summary></details></td><td>1,000</td><td>900</td></tr></tbody></table>''')
  data=statement(page,'income-statement');self.assertEqual(data['eps'],[{'value':7.46,'unit':'perShare','period':'2025-09'}]);self.assertEqual(data['revenue'][0]['value'],1e9)
  self.assertEqual(statement(Selector(page.html_content.replace('In millions of $ except per-share values','Unknown currency')),'income-statement'),{})
 def test_cashflow_and_equity_derivations(self):
  values={'totalEquity':500,'bookEquity':500,'shares':10,'dividendsPaid':20,'netIncome':50,'incomeTax':25,'pretaxIncome':100,'receivableCashChange':-20,'inventoryCashChange':-10,'payableCashChange':15,'otherWorkingCashChange':10}
  d={'statementDate':'2025-09','facts':{k:{'value':v,'period':'2025-09','unit':'currency'}for k,v in values.items()}}
  derive(d);self.assertEqual(d['facts']['workingCapitalChange']['value'],5);self.assertEqual(d['facts']['taxRate']['value'],.25);self.assertEqual(d['facts']['dividendPerShare']['value'],2);self.assertEqual(d['facts']['minority']['value'],0)
  d={'statementDate':'2025-09','facts':{'bookEquity':{'value':500,'period':'2025-09','unit':'currency'}}};derive(d);self.assertNotIn('minority',d['facts']);self.assertNotIn('dividendPerShare',d['facts'])

if __name__=='__main__':unittest.main()
