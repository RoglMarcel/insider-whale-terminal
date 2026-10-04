# Exit strategy — what the literature says, and what we changed

**Scope.** This decides three numbers for the *simulated* testing portfolio
(`src/types/index.ts`, applied in `evaluateExit`): how long a position stays
open, whether there is a profit target, and whether there is a stop. It is a
parameter study of a paper-trading instrument against published research. It is
not investment advice, and none of it is a recommendation to trade real money.

**Method rule.** Every value below traces to at least one peer-reviewed or SSRN
source with full metadata. Nothing is justified by our own six closed trades
(t = 0.66, 95% CI −7.9% … +15.9%). Where our own data appears, it appears as a
*consistency check* and is labelled as one.

---

## 1. The settings table

| Parameter | v1.4.0 | **v1.5.0** | Plausible range | Primary evidence | Confidence |
|---|---|---|---|---|---|
| Max holding period | 30 d | **90 calendar days** | 60–180 d (literature stretches to 250) | Jeng/Metrick/Zeckhauser 2003; Lakonishok/Lee 2001; Cohen/Malloy/Pomorski 2012; Kang/Kim/Wang 2018 | **medium-high** that 30 d is too short · **medium** on 90 specifically |
| Take-profit | +20% | **none — barrier disabled** | none; if one must exist, ≥ +60% | Bessembinder 2018; Odean 1998; own right-tail census (§6) | **medium-high** |
| Stop-loss | −10% | **−25%** (≈ 1 horizon σ) | −20% … −35%, or 1.0–1.5 σ_H | Kaminski/Lo 2014; Jegadeesh 1990; López de Prado 2018 | **medium** |
| Trailing arm / distance | +15% / 10% | **+25% / 20%** | arm +20–30%, distance 15–25% | none direct — derived from σ | **low** |
| Barrier type | fixed % | **fixed % shipped, σ-scaled implemented and swept** | — | López de Prado 2018; Barroso/Santa-Clara 2015; Moreira/Muir 2017 | **medium** on the principle · **low** on any specific multiple |

Two of the five are confidently determined, two are not. §12 says which.

---

## 2. The holding-period return curve

Expected cumulative abnormal return after an insider **purchase**, versus the
study's own benchmark, by trading day. `M` = measured in a source, `I` =
interpolated by us between measured points.

| Trading day | Cumulative abnormal return | Marginal, bp/trading day | Basis |
|---:|---:|---:|---|
| 5 | **+0.90%** | 18.0 | **M** — JMZ: "about one quarter" of the six-month total accrues in the first five days |
| 10 | +1.20% | 5.6 | **I** |
| 20 | **+1.75%** | 5.7 | **M** — JMZ: "one-half … within the first month"; KKW independently measure **+2.0%** over 21 trading days for non-cluster purchases |
| 40 | +2.10% | 1.7 | **I** |
| 60 | +2.50% | 1.7 | **I** |
| 90 | +3.00% | 1.7 | **I** — KKW: the cluster/non-cluster gap widens a further **2.5 pp** between day 21 and day 90, i.e. the drift is still running |
| 120 | +3.50% | 1.7 | **I** |
| 126 (6 m) | **+3.60%** | — | **M** — JMZ: 52–68 bp/month for six months (midpoint 60 bp) |
| 180 | +4.60% | 1.9 | **I** |
| 250 (12 m) | **+6.00%** | 1.9 | **M** — JMZ ">6% per year"; Lakonishok/Lee **+7.4%** over 12 months in small caps |

**The shape is the whole argument.** The drift is violently front-loaded for
about a week (18 bp/day), decays through the first month (≈6 bp/day), and then
runs at a **flat ~1.7–1.9 bp per trading day all the way out to a year**. It does
not decay to zero at day 30. A 30-day time stop does not sit at a plateau; it
sits at the start of a long, low, positive slope.

### 2.1 The part of that curve we can actually reach

JMZ measure from the **transaction** date. We cannot. Between the trade and our
entry sit:

- the **SEC Form 4 deadline** — two business days since SOX §403 (it was the
  10th of the following month over most of JMZ's 1975–1996 sample, which is why
  their day-0-to-5 chunk was not capturable by outsiders at all then);
- our own scrape latency;
- `earliestEntryDate()`, which prices a post-close sighting at the **next**
  session — 2,201 of 12,728 stored sightings are at or after 20:00 UTC.

Realistically we enter around trading day 3, having forfeited ≈0.54 pp of the
0.90 pp first-week burst. What is left to us:

| Time stop | Trading days held from entry | Abnormal return still available |
|---|---:|---:|
| 30 calendar days | ≈ 21 | **≈ 1.25%** |
| 90 calendar days | ≈ 62 | **≈ 1.96%** |
| 180 calendar days | ≈ 124 | ≈ 3.01% |
| 250 calendar days | ≈ 172 | ≈ 3.96% |

Going from 30 to 90 days raises the harvestable abnormal return by **≈57% for
the same single round trip**. That is the case for the change, in one line.

---

## 3. Sources

Practitioner material is marked and is used only for implementation colour or as
a pointer to a paper; no vendor number enters the settings table on its own.

| Source | Sample | Market / universe | n | Horizon | Result | Weighting / net of costs |
|---|---|---|---|---|---|---|
| **Jeng, Metrick & Zeckhauser (2003)**, *Estimating the Returns to Insider Trading*, Rev. Econ. & Stat. 85(2) 453–471 | 1975–1996 | US, all exchanges | insider transaction universe | 6 months, event-portfolio | Purchases **52–68 bp/month**, **>6%/yr**; sales ≈ 0. **¼ of it inside 5 days, ½ inside 1 month** | Performance-evaluation portfolio; gross. Cost to non-insiders estimated ≈10¢ per $10,000 |
| **Lakonishok & Lee (2001)**, *Are Insider Trades Informative?*, RFS 14(1) 79–111 | 1975–1995 | NYSE/AMEX/Nasdaq | all companies | 12 months | Purchases informative, sales not; **≈+7.4% over 12 months in small caps**; effect concentrated in small firms | Gross; effect is a size effect |
| **Cohen, Malloy & Pomorski (2012)**, *Decoding Inside Information*, J. Finance 67(3) | Jan 1986 – Dec 2007 | US | >½ of all insider trades are "routine" | Calendar-time portfolio, monthly | **Opportunistic purchases 82 bp/month value-weighted (≈9.8%/yr)**; routine ≈ 0. Routine = trades in the *same calendar month* for **3 consecutive years** | **Value-weighted**; gross |
| **Kang, Kim & Wang (2018)**, *Cluster Trading of Corporate Insiders* | 1986–2016 | US | — | 21 and 90 trading days | Cluster purchases **+3.8%** vs non-cluster **+2.0%** at 21 td; the gap **widens a further ~2.5 pp by day 90** | Gross |
| **Dardas (2011)**, *Identifying Profitable Insider Transactions*, EBS | Jan 2002 – Dec 2009 | 17 Western European countries | — | 12 months | High-conviction purchases **+20.94%**, medium +1.32%, low −3.40% | Gross; upper bound, heavily selected subset |
| **Seyhun**, *Investment Intelligence from Insider Trading* (MIT Press) | 1975–1996 | US | ~universal insider dataset | 12 months | Imitating purchases beats the market by **≈2%**; aggregate net purchases predicted up to 60% of the variation in one-year-ahead market returns (Seyhun 1992, QJE) | Gross |
| **"Insider Purchase Signals in Microcap Equities"** (arXiv 2602.06198) | 2018–2024 | US microcaps, $30M–$500M | **17,237** purchases, 1,343 issuers | 20 / **30** / 60 td post-**filing** | Mean CAR **+6.3%** for purchases disclosed after >10% prior gains (median 1.93%); Pr(CAR>10%) 22.6–36.7%; **"predictive power weakens at longer horizons"** | FF3, betas over 252 prior days. **Net:** at 2% effective spread + 1% impact the 6.3% falls to **≈3.3%** |
| **Bessembinder (2018)**, *Do Stocks Outperform Treasury Bills?*, JFE | Jul 1926 – Dec 2016 | US | **25,967** stocks | lifetime | **57%** of stocks underperform 1-month T-bills over their life; the best **4%** account for the entire net market gain; **0.33%** account for >50%. Mean lifetime BH return >30,000% vs **median −6.9%** | Establishes the right-skew that a fixed profit cap collides with |
| **Odean (1998)**, *Are Investors Reluctant to Realize Their Losses?*, J. Finance 53 1775–1798 | 1987–1993 | US retail | 10,000 accounts | — | Investors are **1.5–2×** more likely to sell a winner than a loser; not justified by subsequent performance | The disposition effect |
| **Kaminski & Lo (2014)**, *When Do Stop-Loss Rules Stop Losses?*, J. Fin. Markets | Jan 1950 – Dec 2004 | US | monthly + futures | — | Under a **random walk** a simple 0/1 stop **always reduces** expected return. Under **momentum** the "stopping premium" is positive and proportional to return persistence; certain stops added **50–100 bp/month** during stop-out periods | The precondition test for having a stop at all |
| **Jegadeesh (1990)** / Lehmann (1990) | 1934–1987 | US | — | 1 month | One-month losers beat winners by **≈2%/month**; this is why momentum research skips the most recent month (2-12 rather than 1-12) | Places a ~30-day window in the **reversal** zone |
| **Barroso & Santa-Clara (2015)**, *Momentum has its moments*, JFE 116(1) 111–120 | — | US | — | — | Scaling exposure by predictable realised risk **virtually eliminates crashes and nearly doubles** momentum's Sharpe ratio | The academic warrant for volatility scaling |
| **López de Prado (2018)**, *Advances in Financial Machine Learning* | — | — | — | — | The **triple-barrier** method: profit-take, stop-loss and an expiry, with the horizontal barriers set as **multiples of estimated volatility**, not fixed percentages | Methodological standard our `evaluateExit` is measured against |
| SOX §403 / SEC Form 4 | — | — | — | — | Form 4 due within **two business days** (was: 10th of the following month). Post-SOX, ~8% of transactions still miss the deadline and earn abnormal returns while undisclosed | Signal age |
| *Practitioner:* 2iQ Research literature review; quantdecoded.com; ATR-stop vendor backtests | — | — | — | — | Used only as pointers to the papers above and for implementation colour | **Not used for any table value** |

### 3.1 Where the sources disagree — not averaged away

**The long-horizon US studies vs the recent microcap replication.** JMZ, LL, CMP
and KKW all find drift persisting for months. The 2018–2024 microcap paper finds
its 30-day post-filing window optimal and says predictive power *weakens* at 60
days. Both numbers stand:

- They measure from different clocks — JMZ from the **transaction**, the microcap
  paper from the **filing**. Post-SOX the filing is ≤2 business days later, so
  this is a small offset now and a large one in JMZ's sample.
- The microcap paper's universe is $30M–$500M and its own cost analysis knocks
  the headline 6.3% down to ≈3.3%. It is the study most like our tape *and* the
  one warning loudest about costs.
- The honest reading: **90 days is where the two literatures overlap least
  badly**. It is well past the 30-day window our old rule harvested, and well
  short of the 6–12 months the older large-sample work would justify. If the
  microcap result generalises, 90 gives away part of the tail; if the classical
  result generalises, 90 leaves ~40% of the year's drift on the table. That
  two-sided cost is why confidence on the specific number is *medium*, not high.

**Post-SOX informativeness.** One strand finds insider purchases *more*
informative after SOX (3-day CAR 0.59% → 1.89%); another finds short-horizon
returns that "vanish and even become negative when limiting the tradable dollar
amount … to a reasonable size". Both are consistent with our conclusion: the
short end is contested and cost-sensitive, the medium horizon is where the
robust part of the effect lives.

---

## 4. Why there is no fixed take-profit any more

### 4.1 The arithmetic

Model a post-insider-purchase holding period as lognormal, calibrated to the
volatility our tape actually shows. **This is a model, not a measurement** —
assumptions stated, and the conclusion is checked against our own data in §6.

Small cap, σ = 50% annualised, 90 calendar days (≈62 trading days), E[R] = +5.0%,
horizon σ = 24.8%:

| Terminal return above | Probability | Contribution to gross return | Share of the total |
|---|---:|---:|---:|
| +20% | 25.4% | **+10.2 pp** | **205%** |
| +50% | 5.9% | +4.0 pp | 80% |
| +100% | 0.3% | +0.4 pp | 8% |

Paths above +20% contribute **more than twice the entire expected return**; the
remaining three quarters of the distribution net **−5.2 pp**. Capping the winners
therefore does not trim the top of a symmetric distribution — it deletes the only
part that pays.

**What the cap costs, by hold length and volatility:**

| Scenario | Uncapped E[R] | With a hard +20% cap | With +30% | With +50% |
|---|---:|---:|---:|---:|
| 30 d, σ 50% | +2.50% | **+1.39%** (−44%) | +2.15% | +2.48% |
| 90 d, σ 35% (mid cap) | +5.00% | **+2.53%** (−49%) | +3.93% | +4.84% |
| 90 d, σ 50% (small cap) | +5.00% | **−0.16%** (−103%) | +1.89% | +3.96% |
| 180 d, σ 50% | +8.00% | **−2.57%** | +0.20% | +3.85% |

The +20% cap was already costing roughly **half** the expected return at the old
30-day hold. At the new 90-day hold it would cost **all of it**. The result is
robust across the volatility assumption: at every setting tested, the cap removes
between 44% and 103% of expected return.

And this understates it, because `evaluateExit` fires on the **path**, not on the
terminal value: a position that touches +20% on day 9 and finishes at +65% is
sold on day 9. The terminal-value numbers above are a lower bound on the damage.

### 4.2 Odean

A rule that sells winners at a fixed +20% while letting losers run to the full
−10% is the **disposition effect** (Odean 1998: investors are 1.5–2× more likely
to realise a winner, and it is not justified by subsequent performance) encoded
as a config constant. The old ratio made it worse than the human version: the
target sat at 2× the stop distance, so the winner was cut at twice the speed the
loser was.

### 4.3 What replaces it

The **trailing stop**. It is path-dependent, so it cannot truncate a trend that
is still going — it only acts once the trend has already broken. That is the
correct shape for a right-skewed distribution.

### 4.4 Implemented as absent, not as 999%

`PortfolioConfig.takeProfit` is now `number | null`. `null` means the barrier does
not exist: `evaluateExit` skips it, `nearestBarrier` contributes no candidate for
it, the rules card prints "No take profit — the upside is never capped", and the
runtime editor has an on/off switch. Setting it to 999% would have put a
meaningless number on screen *and* still truncated a ten-bagger.

---

## 5. The stop-loss, and whether a stop belongs here at all

Kaminski & Lo give the precondition: a stop adds expected return **only** under
positive serial correlation. Under a random walk a simple 0/1 stop *always*
reduces it. So: which regime is a stock in, shortly after an insider bought it?

- **Against a stop:** at the one-month horizon individual stocks are in the
  **short-term reversal** regime — Jegadeesh (1990) measures ~2%/month on
  one-month losers, large enough that momentum research routinely skips the most
  recent month. A −10% stop sells precisely the name that reversal says to hold.
- **Against a stop:** insiders are documented **contrarian** buyers (Lakonishok &
  Lee), so the entry population is already tilted toward recent losers.
- **For a stop:** the 2026 microcap study finds the *strongest* CAR (+6.3%) among
  purchases disclosed after >10% prior gains — momentum, not reversal, in the
  post-insider-buy population specifically.

The evidence does not cleanly support a stop as an **alpha** rule. It does
support one as a **tail-risk** rule: the cases a stop should catch are fraud,
dilution and delisting — the cases where "an informed insider bought" is simply
false. That job needs a barrier far outside the noise.

**Sizing it.** −10% is inside one *daily* 3σ move for a 48%-vol ticker and is
0.4 horizon σ over a 90-day hold: it fires on noise. At σ_daily = 3% and 62
trading days, one horizon σ ≈ **23.6%**. **−25% ≈ 1 σ_H**, which is why the fixed
fallback and the σ-scaled recommendation land on the same number from two
independent directions.

---

## 6. Consistency check — our own data

Two of the claims above are testable on our own tape without touching the six
closed trades. `signal_outcomes` now holds **5,631** labeled rows after
`scripts/label-outcomes.ts` was extended (§9), entry dates 2026-07-10 → 2026-08-16.

**Right tail, all signals** (`ret` = raw return, not alpha):

| Horizon | n | P(ret > +20%) | P(ret > +50%) | Share of Σ alpha from the top decile |
|---:|---:|---:|---:|---:|
| 5 d | 2,207 | 1.5% | 0.2% | **491%** |
| 10 d | 1,587 | 2.8% | 0.6% | **145%** |
| 20 d | 1,279 | 4.9% | 1.1% | **535%** |
| 40 d | 558 | **10.2%** | 0.7% | **732%** |

Both predictions hold in our own universe:

1. **The fraction above +20% rises monotonically with horizon** — 1.5% → 10.2%.
   At 40 days one position in ten has already passed the old take-profit. Every
   one of them would have been sold at +20%.
2. **The top decile carries more than 100% of the total alpha at every horizon**
   (145%–732%), meaning the other 90% nets negative. That is Bessembinder's
   pattern measured on our own signals, at n = 558–2,207 — three orders of
   magnitude more observations than the portfolio's six trades, and completely
   independent of them.

**Mean alpha by horizon** (medians in brackets — the means are outlier-driven, as
a right-skewed distribution demands):

| Horizon | all signals | score ≥ 74 |
|---:|---|---|
| 5 d | +0.28% (+0.28%), n=2207, t=1.67 | +3.81% (+4.27%), n=8, t=0.93 |
| 10 d | +3.03% (+0.24%), n=1587, t=1.59 | +9.10% (+6.65%), n=8, t=3.36 |
| 20 d | +0.46% (+0.00%), n=1279, t=1.21 | +14.62% (+8.54%), n=7, t=1.59 |
| 40 d | +0.44% (+0.87%), n=558, t=0.54 | +7.93% (+6.65%), n=3, t=5.11 |

**Caveat that limits all of it:** the entry dates span five weeks, so the 40-day
sample is drawn from the earliest ~10 days of that window and the observations
overlap heavily in calendar time. Effective n is far below nominal n, and the
`score ≥ 74` column is n = 3–8 and uninterpretable on its own. What survives that
caveat is the right-tail census above, which is a cross-sectional count and does
not depend on the alpha estimate being precise.

---

## 7. The conflict with our own sweep — resolved

`docs/portfolio/REPORT.md` §5/§7.1 reported per-trade alpha decaying
*monotonically* with holding length at four of five entry thresholds, and
concluded the time stop was probably too **long**. That points the opposite way
from everything in §2. It has to be addressed, not averaged.

**Three things are wrong with reading that table as a horizon result.**

1. **The long rows never happened.** The sweep window is 31 sessions. The 45-day
   and 60-day rows printed *identical* numbers — because the time stop never
   bound, so both rows are "hold until some other barrier or the end of the
   data". They are the same experiment twice, not two horizons. Re-running the
   extended sweep today makes this unmissable: at 45 d and beyond every threshold
   collapses to **n ≤ 1** closed trade (n = 1 at the ≥60/65/70 thresholds, n = 0
   at ≥74 and ≥78), and the 45/60/90/120/180 rows are byte-identical to one
   another. One trade is not a horizon study; zero is not one either.

2. **The columns are not comparable quantities.** "Per-trade alpha" at a 10-day
   cap is alpha earned over ≤10 days; at 60 days it is alpha over ≤60 days. Alpha
   *per unit of time* falls with horizon in every source in §2 — that is the shape
   of the curve, not an argument against holding. The decision variable is
   marginal alpha per day *versus the alternative use of the capital*, and…

3. **…the alternative is SPY at zero alpha by construction.** Under
   `cashPolicy: 'spy'` the freed capital parks in the benchmark, so exiting early
   earns exactly the benchmark and contributes **0** to trade alpha. Recycling
   capital faster would only help if the position slots were the binding
   constraint. They are not: 7 entries against `maxPositions: 20`, and
   `skipped_cap = 0` in every run. **Signals are scarce; slots are free.** With a
   free slot and a positive marginal alpha of ~1.7 bp/trading day out to a year,
   every extra day held is a gain, not an opportunity cost.

**Which measurement gets the weight.** The literature, decisively. It covers
decades and tens of thousands of transactions; the sweep covers 31 sessions,
6 closed trades and a time stop that could not bind past day ~40. Our own data is
not evidence *against* the long horizon — it is evidence about a question it
cannot see. What our data *can* see (§6) points the same way as the literature.

---

## 8. Transferability to a $10,000, ≤20-position book

Every source in §2 measures a monthly-rebalanced, often value-weighted portfolio
over decades. We run 3–10% weights on daily adjusted closes with 5 bps slippage
and no shorting. Per finding:

| Finding | Transfers? | Why |
|---|---|---|
| JMZ's curve shape (front-load then flat tail) | **Yes** | A property of the return path, independent of weighting scheme |
| JMZ / LL / CMP effect *magnitudes* | **Partly** | CMP is value-weighted; LL's effect is concentrated in small caps where we can trade a $10k account but where costs are worst. Treat magnitudes as an order of magnitude, not a target |
| CMP's opportunistic/routine split | **Yes, and unused** | `scripts/backtest-opportunistic.ts` cites the paper; its classifier reads the per-insider `pattern` column. The paper's own rule is "same calendar month, 3 consecutive years". **Not verified in this pass** — see §11 |
| Bessembinder's skew | **Yes, amplified** | 20 positions is a *smaller* sample of the same skewed distribution, so we depend on the tail even more than a 500-name index does |
| Kaminski/Lo's stop result | **Weakly** | Measured on monthly index/futures returns, not on single stocks at daily frequency. It is used only for its *precondition* ("stops need momentum"), not for its magnitudes |
| Vendor ATR-stop backtests | **No** | FX/crypto, vendor-run, not peer-reviewed. Excluded from the table |
| The microcap cost warning | **Yes, and it binds** | Our 5 bps assumption is optimistic for $30M–$500M names. This is the weakest link in the whole chain — see §10 |

---

## 9. Costs

5 bps per side = **10 bps per round trip**, charged on both legs including the SPY
cash leg.

| Time stop | Gross abnormal return available (§2.1) | Round-trip cost | Cost as a share of gross |
|---|---:|---:|---:|
| 30 d | ≈1.25% | 0.10% | 8.0% |
| 90 d | ≈1.96% | 0.10% | **5.1%** |
| 180 d | ≈3.01% | 0.10% | 3.3% |

At 5 bps, costs do not decide anything — but they push the same direction as the
curve, because a longer hold amortises one round trip over more alpha. **Every
recommendation here survives its own cost assumption.**

The real cost risk is not our slippage constant, it is whether 5 bps is true. The
microcap study's own estimate — 2% effective spread plus 1% price impact turning
a 6.3% CAR into ≈3.3% — is what a $50k order in a $100M-cap name actually pays.
Our tickets are $300–$1,000, so impact is negligible, but the **spread** is not.
A 2% round-trip spread would consume the entire 90-day edge. This is flagged, not
solved: see §12.

---

## 10. What changed in the code

| Change | File |
|---|---|
| `PORTFOLIO_TAKE_PROFIT = null`, `PORTFOLIO_STOP_LOSS = 0.25`, `PORTFOLIO_MAX_HOLD_DAYS = 90`, `PORTFOLIO_TRAIL_ARM = 0.25`, `PORTFOLIO_TRAIL_DISTANCE = 0.20` | `src/types/index.ts` |
| `takeProfit` / `stopLoss` typed `number \| null`; optional σ-scaled barriers (`PortfolioSigmaBarriers`) | `src/types/index.ts` |
| `evaluateExit` / `nearestBarrier` skip a disabled barrier; new `resolveBarriers` and `realizedDailyVol` | `src/lib/portfolio-rules.ts` |
| Entry volatility captured once per position and never re-estimated | `src/lib/portfolio-rules.ts` |
| Rules card composes the exits line from parts; runtime editor gets on/off switches for both optional barriers | `RulesCard.tsx`, `PortfolioConfigForm.tsx`, `i18n.ts` |
| One-time config migration (§11) | `electron/database.ts` |
| Hold rows to 180 d; no-TP / no-SL / σ-scaled variants; n, t and 95% CI per row; `n < 10` marked uninterpretable | `scripts/portfolio-sweep.ts` |
| Horizons `[5,10,20]` → `[5,10,20,40,60,90,120,180]`, plus the durable-candidate fix | `scripts/label-outcomes.ts`, `electron/database.ts` |

### 10.1 Barrier type: why σ-scaling is implemented but not switched on

A −10% stop is a routine week for an 85%-vol biotech and a crisis for an 18%-vol
utility, so a fixed percentage genuinely means two different things. López de
Prado's formulation sets the horizontal barriers as multiples of estimated
volatility for exactly this reason, and Barroso/Santa-Clara and Moreira/Muir show
that scaling by realised risk improves risk-adjusted outcomes in general.

`resolveBarriers` implements it: σ_H = (60-day realised daily log-return vol at
entry) × √(trading days in the time stop), fixed at entry so the barrier is a
static level rather than a line that walks around under the position. A ticker
with too little history falls back to the fixed percentage — a barrier that
cannot be computed must not become a barrier that never fires.

It ships **off**. The principle is well supported; no specific multiple is. Our
sweep cannot yet distinguish them: with the new rules nothing closes inside the
31-session window, so every σ row is byte-identical to the fixed row, and only
**13 of 24** tickers can even produce a 60-day σ on day one. Turning on an
unvalidated rule because its principle is sound is precisely the mistake this
repo's parameter discipline exists to prevent.

### 10.2 What the extended sweep says today

Nothing yet, and it says so. Under the new rules **0 of 7 positions close** inside
the stored window: no take-profit, the −25% stop never trips, the 90-day stop
never binds. The book shows +5.30% against SPY +1.43% (**+3.87%**, versus +1.02%
under v1.4.0) at an unchanged −3.67% max drawdown — but that is seven *unrealised*
marks on the same seven trades, `alphaN = 0`, and **not a result**. The one row
that hints at anything (`+20% / no SL`, Ø α +21.08%, t = 29.49) rests on n = 2 and
is flagged uninterpretable, as is every other row in the file.

---

## 11. Migration for existing installations

**The constant alone does not reach a running app.** `getPortfolioConfig`
(`electron/database.ts`) merges `app_settings.portfolio_config` **over** the
defaults, and `setPortfolioConfig` — which the rules editor calls — writes the
*whole merged object* back. So once anyone has opened that editor even to change
the starting cash, all five exit rules are pinned in SQLite and a new default in
`src/types` never arrives.

`migratePortfolioConfig()` runs once, from `initDatabase`, guarded by
`app_settings.portfolio_config_version` against `PORTFOLIO_CONFIG_VERSION`:

- a stored exit value that still equals its **v1.4.0 default** is **deleted** from
  the overlay, so the new default shows through — and so will the next one;
- a stored exit value that **differs** is a deliberate choice and is **kept**;
- the outcome is logged (`reset to new defaults [...] · kept your own values for [...]`);
- it is best-effort: a config that cannot be reconciled must not stop the app from
  starting.

Deleting rather than overwriting is the point — the overlay ends up holding only
what the user actually decided.

**Then the curve must be rebuilt.** A chart drawn with a +20% take-profit cannot
be relabelled. `verify:portfolio` already detects this and now warns
*"stored parameters match the active configuration — the config was changed
without a rebuild"*; the fix is one `npm run portfolio:sync`. On the shipped
history database there is no overlay at all, only `portfolio_meta`, so the
migration stamps the version and changes nothing.

---

## 12. Scoring factors (separate from the exits)

Three changes, none of them fitted to any trade outcome.

1. **An unparsed insider role is now UNKNOWN, not the lowest rank.**
   `getRankWeight('')` returned weight 1 — the floor — so a missing title scored
   like the most junior insider in the company. Nothing supports that: an unparsed
   title is a scraping gap, not a demotion. It now returns **4**, the *mode* of the
   rank weights over the 7,967 stored signals whose role **is** recognised
   (42.9% at weight 4; median 5, mean 6.08). The mode is the conservative choice
   of the three — it assumes the most common insider we actually see, a director,
   and never lets an unknown title outrank a known one. Affects 4.5% of the 8,343
   signals with an insider leg.

2. **The rank/finance double-count is resolved.** A CFO carried rank weight 8
   against a director's 4 *and* triggered the ×1.3 pre-earnings finance bonus —
   one fact ("this person sees the numbers first") counted twice in the same
   multiplicative chain. `earnsFinanceTimingBonus()` now withholds the bonus where
   the rank already pays for it (category `cfo`) and keeps it where it does not: a
   Controller, Treasurer or VP Finance is ranked like any other officer, so for
   them the bonus is genuinely new information. Golden diff: two of fifteen cases
   move (78.6 → 73.9, 100 → 97.5), no tier changes.

3. **The three dead knobs are now visibly dormant rather than silently neutral.**
   `docs/audit/FACTORS.md` measured `vixMultiplier`, `valuationMultiplier` and
   `comboBonus` at 0.0% of score variance. That is not evidence against them — it
   is evidence they never fired, and a ×1.0 meaning "VIX unknown" was
   indistinguishable from a ×1.0 meaning "the market is calm". `ScoreBreakdown`
   now carries `dormantFactors: {factor, reason}[]`, surfaced in the breakdown
   panel: `vixMultiplier` when there is no VIX reading, `valuationMultiplier`
   whenever no fair-value estimate exists (permanent since both providers were
   removed — which is also why a fully enriched signal tops out at 95 confidence,
   not 100), and `comboBonus` when a combo was detected but the corroboration gate
   blocked it. **No score changes from this.** It converts "dead" into "dormant,
   and here is why", which is the distinction the audit could not previously make.

**Not done, deliberately:** no weight was refitted. The `scripts/backtest-opportunistic.ts`
classifier was **not** verified against Cohen/Malloy/Pomorski's exact definition
(routine = same calendar month, three consecutive years) — the script reads a
pre-computed `pattern` column, and checking how that column is produced is a
separate piece of work than this one.

---

## 13. What would change our mind

| Setting | What would move it |
|---|---|
| **90-day hold → shorter** | `signal_outcomes` reaching n ≥ 200 at both 60 and 90 days (earliest 2026-09-08 and 2026-10-08 respectively) and showing mean alpha at 90 d **below** 40 d with a CI excluding zero. Or a post-2015 large-sample replication finding the drift genuinely gone past one month in liquid names |
| **90-day hold → longer (180–250)** | The 90 d and 120 d labels confirming the flat ~1.7 bp/day tail, plus ≥30 closed trades showing no decay. The literature already supports 180+; only our own inability to validate it holds us at 90 |
| **No take-profit → reinstate one** | Evidence that our exits are path-truncating for a reason we have not modelled — e.g. positions that touch +50% and finish below entry more often than the lognormal model predicts. Measurable directly once `n ≥ 30` closed trades exist |
| **−25% stop → tighter** | Kaminski/Lo's precondition being met on *our* population: post-entry daily returns showing significant positive autocorrelation. Computable from `signal_outcomes` once the 60- and 90-day labels land |
| **−25% stop → removed** | The `no SL` sweep row beating the stop row at **every** entry threshold with n ≥ 10 per cell |
| **σ-scaled barriers → shipped on** | The σ table separating from the fixed row at n ≥ 10 per row, with ≥20 of 24 tickers σ-ready. Both preconditions currently fail |
| **The whole thesis** | Our 5 bps slippage assumption being wrong for the small caps that carry the edge. If a spread study on our actual traded universe shows a round trip nearer 200 bps than 10 bps, the 90-day edge is gone and the conversation becomes about the entry filter, not the exit |

---

## 14. Which of the three we actually determined

**Determined with confidence:**

- **The take-profit had to go.** Three independent lines agree — the right-skew
  arithmetic (§4.1, the cap costs 44–103% of expected return across every
  volatility assumption tested), the behavioural literature (§4.2), and our own
  right-tail census (§6: the top decile carries 145–732% of total alpha, at
  n = 558–2,207). This is the one change that does not depend on picking a number.
- **30 days was too short.** Every large-sample study measures over 6–12 months,
  the marginal alpha is still ~1.7 bp per trading day at day 250, and the freed
  capital's alternative is a zero-alpha SPY park with free position slots. The
  direction is not in doubt.

**Not determined:**

- **90 days specifically.** The plausible range 60–180 is wide, and the two
  literatures bracket it from opposite sides (§3.1). 90 is a defensible midpoint
  under stated assumptions, not a measured optimum.
- **−25% specifically.** That −10% was too tight is well supported; whether the
  right answer is −20%, −25%, −35% or no stop at all is not resolved. The
  literature says a stop needs momentum to help, our population is plausibly in
  reversal, and we kept a wide one for tail risk rather than for alpha.
- **The trailing stop, at all.** +25% / 20% is derived from σ, not from any study.
  No source tests trailing-stop geometry on insider signals. With the take-profit
  gone, this is now the *only* upside exit, which makes it the least-evidenced
  parameter carrying the most weight — the single most important thing to measure
  next.
