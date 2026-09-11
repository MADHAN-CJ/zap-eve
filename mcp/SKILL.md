---
name: dhan-data
description: Query a live Dhan (DhanHQ v2) trading account by writing Python. Use for anything about the user's positions, holdings, funds, orders or trades, and for Indian market data — LTP/quotes, intraday and daily candles, option chains, expiries, per-contract option candles, and expired-option history. Trigger on questions about P&L, a position, NIFTY/BANKNIFTY/SENSEX or any NSE F&O stock, option IV/OI/greeks, max pain, or "what is X trading at".
---

# Dhan data via Python

You have exactly one tool: **`run_python(code)`**. It executes your Python on a
server that already holds the user's Dhan credentials and returns whatever the
script printed.

There are no per-endpoint tools. Fetch, compute, and print a conclusion in one
script rather than pulling raw data back and reasoning over it here.

## How to use it well

- **Print small.** A NIFTY option chain is hundreds of rows; 180 daily candles
  is thousands of numbers. Do the aggregation in Python and print the handful of
  numbers you actually need. Output over ~100k characters is elided from the
  middle.
- **One script, many calls.** Chained work (resolve → chain → per-strike candles)
  belongs in a single script. Every tool round trip costs far more than a loop.
- **Errors come back as text.** A traceback is a normal result, not a failure —
  read it and send a corrected script.
- **Everything is read-only.** There is no order placement, modification, or
  cancellation. If asked to trade, say plainly that this tool only reads.
- **A trailing bare expression is echoed** (REPL-style), so a script can end in
  `summary` instead of `print(summary)`.
- Only the standard library is guaranteed. `json`, `math`, `statistics`,
  `datetime`, `timedelta`, `date` are already in the namespace. No pandas/numpy.
- `print(help_api())` lists every available function with its first doc line.

## Instruments: ids, segments, instrument types

Dhan addresses instruments by **`securityId` + `exchangeSegment`**, never by
ticker. Segments: `NSE_EQ`, `BSE_EQ`, `IDX_I` (indices), `NSE_FNO`, `BSE_FNO`,
`MCX_COMM`, `NSE_CURRENCY`.

`resolve_underlying(ticker)` maps an F&O underlying's ticker to its id — 8
indices (`NIFTY`, `BANKNIFTY`, `FINNIFTY`, `MIDCPNIFTY`, `NIFTYNXT50`, `SENSEX`,
`BANKEX`, `SNSX50`) plus 210 NSE F&O stocks:

```python
resolve_underlying("NIFTY")      # {'scrip': 13, 'seg': 'IDX_I', 'name': 'NIFTY'}
resolve_underlying("RELIANCE")   # {'scrip': 2885, 'seg': 'NSE_EQ', 'name': 'RELIANCE'}
```

It raises `ValueError` on an unknown name rather than guessing — say so plainly
instead of inventing an id. `list_underlyings("stock")` enumerates them.

For **anything outside that F&O universe** (a non-F&O stock, a specific option
or futures contract), you need the id from elsewhere: the user's own
`positions()`/`holdings()` rows carry `securityId`, `exchangeSegment` and
`tradingSymbol`, and `option_chain()` rows carry each contract's `securityId`.

Chart calls also need an `instrument` enum; `guess_instrument(segment, symbol)`
derives it (`EQUITY`, `INDEX`, `OPTIDX`, `OPTSTK`, `FUTIDX`, `FUTSTK`) and is
applied automatically when you omit it.

## Account reads

These work on every account, with no data subscription needed.

```python
positions()   # list of open positions: securityId, exchangeSegment, productType,
              # tradingSymbol, netQty, buyAvg, sellAvg, realizedProfit, unrealizedProfit
holdings()    # demat delivery: securityId, tradingSymbol, totalQty, avgCostPrice,
              # isin, lastTradedPrice  <- the only price source on unsubscribed accounts
funds()       # availabelBalance (Dhan's spelling), utilizedAmount, collateralAmount,
              # withdrawableBalance
orders()      # today's order book, all statuses
trades()      # today's fills

position_for(security_id, exchange_segment=None, product_type=None)
# One instrument's live state. Checks positions() first, then falls back to
# holdings() (delivery holdings never appear in positions unless traded today).
# Returns None when neither has it — i.e. closed/squared off/sold.
# The row carries "_source": "positions" | "holdings", and positions rows add
# "closed": True when netQty == 0.
```

## Market data

These are **paid Data APIs**. On an account without the subscription they raise
`DhanError` carrying Dhan error 806 — check with `is_data_api_error(e)`. That is
*not* a dead token: the account reads above keep working, and equity prices are
still available from `holdings()["lastTradedPrice"]`.

```python
ltp_of(security_id, exchange_segment) -> float
# Single last price. Automatically falls back to holdings' lastTradedPrice for
# *_EQ instruments when the account has no Data-API subscription.

ltp({"NSE_EQ": [2885, 1333], "IDX_I": [13]})
# Batched -> {segment: {security_id: last_price}}. Batch aggressively:
# the marketfeed limit is 1 request/second (enforced by sleeping).

quote({"IDX_I": [13]})
# -> {segment: {security_id: {lastPrice, volume, dayOpen, dayHigh, dayLow,
#                             lastTradeTime}}}   (volume is cumulative for the day)

intraday_candles(security_id, exchange_segment, instrument=None, interval=15,
                 days_back=5, *, symbol=None, from_date=None, to_date=None, oi=False)
# interval is minutes: 1, 5, 15, 25 or 60. Up to 90 days back.
# oi=True adds openInterest (F&O only).

daily_candles(security_id, exchange_segment, instrument=None, days_back=90,
              *, symbol=None, from_date=None, to_date=None, oi=False, expiry_code=None)
```

Both return a list of rows:
`{"timestamp": <epoch seconds>, "open", "high", "low", "close", "volume"[, "openInterest"]}`.
Use `to_ist(row["timestamp"])` for a readable IST datetime; candles come back
oldest-first.

## Options

```python
expiry_list("BANKNIFTY")        # ['2026-09-17', '2026-09-24', ...] ascending
nearest_expiry("NIFTY")         # soonest expiry not yet passed

option_chain(underlying, expiry=None, strikes_around=10)
# -> {underlying, expiry, underlyingLastPrice,
#     strikes: [{strike, ce: {...}, pe: {...}}]}
# Each side: ltp, iv, oi, oiPrev, volume, bid, bidQty, ask, askQty, avgPrice,
#            prevClose, securityId, delta, theta, gamma, vega
# Trimmed to ±strikes_around around ATM; strikes_around=None gives every strike
# (big). expiry defaults to nearest_expiry().
# RATE LIMIT: 1 call per (underlying, expiry) per 3 s, enforced by sleeping.
# Don't loop over many expiries in one script — it will crawl and may time out.

option_candles(contract_security_id, underlying, interval=15, days_back=5)
# Intraday OHLCV + OI for ONE contract, using a securityId from an option_chain
# row. `underlying` only supplies the exchange (NSE_FNO vs BSE_FNO) and type.

expired_options(underlying, option_type, from_date, to_date, *, strike="ATM",
                expiry_flag="WEEK", expiry_code=1, interval=60,
                fields=("close","iv","oi","strike","spot"))
# History of EXPIRED contracts, addressed as ATM±N rather than by securityId,
# rolling across past expiries — for "how did IV behave into last expiry".
# option_type: "CALL" | "PUT". strike: "ATM", "ATM+3", "ATM-2" (indices ±10,
# stocks ±3). expiry_code starts at 1 (nearest of that series at each point).
# to_date is NON-INCLUSIVE. Windows are capped at 7 days per call — chunk longer
# ranges. SLOW: 11-18 s per call even for small windows.
```

## Indicators, dates, helpers

Aligned series (same length as the input, leading `None` until warm-up):

```python
closes(candles)                 # or closes(candles, "volume") for any column
sma(values, period)             ema(values, period)
rsi(values, 14)                 macd(values, 12, 26, 9)  # {macd, signal, histogram}
bollinger(values, 20, 2.0)      # {upper, middle, lower}
atr(candles, 14)                vwap(candles)            pct_change(values)
```

Dates (all IST): `today()`, `days_ago(n)`, `tomorrow()`, `ymd(d)`,
`to_ist(epoch)`. Output: `pp(value)` pretty-prints as JSON, `pp(rows, 5)` prints
the first 5 of a list.

Errors: `DhanError` (with `.status` and `.body`), `is_data_api_error(e)` for the
806 case, `is_auth_error(e)` for a genuinely expired token — Dhan tokens last 24
hours, and the fix is for the user to reconnect Dhan, not to retry.

Escape hatch: `dhan_get(path)` / `dhan_post(path, body)` reach any other Dhan v2
read endpoint directly.

## Worked examples

**Portfolio P&L, one call:**

```python
pos = positions()
open_pos = [p for p in pos if p.get("netQty")]
total = sum(float(p.get("unrealizedProfit") or 0) for p in pos)
realized = sum(float(p.get("realizedProfit") or 0) for p in pos)
print(f"{len(open_pos)} open | unrealized {total:,.0f} | realized {realized:,.0f}")
for p in sorted(open_pos, key=lambda p: -abs(float(p.get("unrealizedProfit") or 0)))[:5]:
    print(f"  {p['tradingSymbol']:<28} qty {p['netQty']:>6}  {float(p.get('unrealizedProfit') or 0):>12,.0f}")
print(f"cash: {funds().get('availabelBalance'):,.0f}")
```

**Trend read on an index — print levels, not candles:**

```python
u = resolve_underlying("NIFTY")
d = daily_candles(u["scrip"], u["seg"], days_back=200)
c = closes(d)
print("spot", c[-1], "| 20dma", round(sma(c,20)[-1],1), "| 50dma", round(sma(c,50)[-1],1))
print("rsi14", round(rsi(c,14)[-1],1), "| atr14", round(atr(d,14)[-1],1))
hi = max(x["high"] for x in d[-60:]); lo = min(x["low"] for x in d[-60:])
print(f"60d range {lo:,.0f}-{hi:,.0f}, {(c[-1]-lo)/(hi-lo)*100:.0f}% of range")
```

**Max pain and PCR from one chain call:**

```python
ch = option_chain("NIFTY", strikes_around=20)
rows = ch["strikes"]
ce_oi = sum((r["ce"] or {}).get("oi") or 0 for r in rows)
pe_oi = sum((r["pe"] or {}).get("oi") or 0 for r in rows)
pain = {}
for k in (r["strike"] for r in rows):
    pain[k] = sum(
        max(0, k - r["strike"]) * ((r["ce"] or {}).get("oi") or 0)
        + max(0, r["strike"] - k) * ((r["pe"] or {}).get("oi") or 0)
        for r in rows
    )
mp = min(pain, key=pain.get)
print(f"spot {ch['underlyingLastPrice']} exp {ch['expiry']} | PCR {pe_oi/ce_oi:.2f} | max pain {mp:.0f}")
top_ce = sorted(rows, key=lambda r: -((r["ce"] or {}).get("oi") or 0))[:3]
top_pe = sorted(rows, key=lambda r: -((r["pe"] or {}).get("oi") or 0))[:3]
print("CE OI walls:", [r["strike"] for r in top_ce], "| PE OI walls:", [r["strike"] for r in top_pe])
```

**Drill into one strike (chain → contract securityId → candles):**

```python
ch = option_chain("BANKNIFTY", strikes_around=1)
atm = min(ch["strikes"], key=lambda r: abs(r["strike"] - ch["underlyingLastPrice"]))
sid = atm["ce"]["securityId"]
bars = option_candles(sid, "BANKNIFTY", interval=15, days_back=2)
print(f"{atm['strike']:.0f} CE  iv {atm['ce']['iv']}  ltp {atm['ce']['ltp']}")
for b in bars[-6:]:
    print(f"  {to_ist(b['timestamp']):%d %H:%M}  close {b['close']:>8.2f}  oi {b.get('openInterest',0):>10,.0f}")
```

**Handle the unsubscribed-account case gracefully:**

```python
try:
    px = ltp({"IDX_I": [13]})
    print("live", px)
except DhanError as e:
    if is_data_api_error(e):
        print("no Data-API subscription — using holdings' last traded prices")
        for h in holdings():
            print(" ", h["tradingSymbol"], h["lastTradedPrice"])
    elif is_auth_error(e):
        print("Dhan token expired — the user needs to reconnect Dhan.")
    else:
        raise
```

## Reporting back to the user

State prices, quantities and P&L exactly as Dhan returned them; never fill a gap
with an invented number. If a position is closed, an underlying is unknown, or
the data subscription is missing, say so plainly. Timestamps are IST.
