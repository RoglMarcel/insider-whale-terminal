# External fair values — 1.6.4

Fair Value Calculator replaces ValueInvesting.io. Its publicly visible English stock page is fetched through the shared Scrapling adapter in GitHub and the packaged desktop application. Attribution links to the original stock page and identifies its multi-model valuation (CC BY 4.0; https://www.fairvalue-calculator.com/entwickler).

The adapter requires an exact ticker in the heading, the visible US listing marker, a dollar-denominated central fair value in the stock-analysis paragraph, and the dated valuation chart caption. It uses the valuation snapshot date, not the potentially newer quote date. Unsupported listings, missing labels, future dates and zero values are rejected. It does not substitute an analyst price target, bullish scenario or a value for another security. External values remain comparisons; they do not change the internally calculated value, confidence level or alert score.

Alpha Spread and GuruFocus remain optional comparisons. Provider requests are serialized with two seconds between requests. After HTTP 403 or 429, that provider pauses for fifteen minutes. Requests skipped because of this pause are marked `cooldown`, have no invented fetch timestamp, and show the earliest retry time. Other providers continue. Actual failed requests retain their HTTP status.

ValueInvesting is excluded from active requests, comparisons, and legacy snapshot display. Its type remains solely to read historical snapshots. Catalogue entries without the new source are scheduled for refresh, with GME included among priority names. Public archives are not assumed to offer complete current stock coverage or verified listing currencies.

Scrapling improves HTTP compatibility but does not guarantee access through provider limits, paywalls or challenges. The collector does not rotate identities, solve captchas or evade paid access. Real blocks remain explicit; the internal valuation remains independent.
