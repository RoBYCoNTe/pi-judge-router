# Architecture and design notes

This document records *why* the router looks the way it does. The measurements below come from a real
workload (187 sessions, 14.5B tokens), analysed before any of this was written.

## 1. Where the money was

| Model | Share of spend |
|---|---|
| `openai/gpt-5.5` | 24% |
| `deepseek/deepseek-flash` | 17% |
| `zai/glm-5.3-flash` | 14% |
| `openai/gpt-5.6-sol` | 10% |
| other | 35% |

Premium tiers (`gpt-5.5`, `gpt-5.6-sol`, `claude-opus-5`, `claude-sonnet-5`) accounted for roughly
**37% of the bill**. The cheap tiers were already efficient: `zai` was billed almost entirely at
cache-read rates, i.e. prompt caching was already working. The problem was never the price per
token — it was choosing the expensive tier by hand and then staying on it for the whole session.

That is what the router changes: the expensive tier is reached only when a judge says the work needs
it, and never for the mechanical part of a session.

## 2. Why routing is split between a judge and code

The router makes two very different kinds of decision, and it uses different tools for each.

**"Is this task complex?" is a judgement.** It depends on intent, scope and ambiguity — none of which
is a function of token count. A calibrated classifier answers it with a probability, which lets the
threshold be tuned as a policy constant instead of being hidden inside a prompt.

**"Does this provider still have credit?" is a fact.** It is a number returned by an endpoint. Asking
a model to judge it would add latency and a chance of being wrong about something already known. So
code computes it, exactly and for free. This is the same rule the judge skill states for documents:
questions about extracted facts belong in code, not in a model round trip.

The threshold on the judge is deliberately asymmetric: `p(complex) >= 0.3` sends work to the strong
model. Under-provisioning a complex task costs a failed turn and a retry; over-provisioning costs the
price difference on one turn. The distributions observed on real prompts were not close —
a small file-edit task scored `complex = 0.00`, a cross-cutting refactor scored `complex = 1.00`, both
at confidence 1.0 — so a low threshold is cheap insurance rather than a compromise.

## 3. Why the fallback is proactive

pi classifies provider errors before deciding whether to retry. The classification is a pair of
regexes, and credit errors are explicitly non-retryable:

```
NON_RETRYABLE (terminal):
  GoUsageLimitError | FreeUsageLimitError | "Monthly usage limit reached" |
  "available balance" | insufficient_quota | "out of budget" |
  "quota exceeded" | billing | subscription_sharing_usage_limit_exceeded

RETRYABLE:
  overloaded | "currently experiencing high demand" | rate.?limit |
  "too many requests" | 429 | 500 | 502 | 503 | 504 | 520 | 524 |
  service.?unavailable | server.?error | internal.?error | provider error
```

The consequence is structural: `route(request)` receives `reason: "retry"` only for the second group.
An exhausted balance never produces a retry, so no retry hook — not ours, not a third-party
extension's — can react to it. Waiting for the error is not a strategy; the credit has to be read
*before* dispatching.

A second, subtler consequence: regex classification only works when the vendor's message happens to
match. `Anthropic`'s real quota message for third-party apps — *"Third-party apps now draw from extra
usage, not plan limits"* — matches neither group, so it is classified `ignore`. An error-driven
extension does nothing, while a probe that reads the account state does not care what the error says.

## 4. Why fail-open is not optional

The probe runs in front of every request. Anything it cannot determine must resolve to "use the
primary":

- the endpoints are not a formal contract and can change shape without notice;
- a probe timeout must not delay a turn indefinitely;
- a 401 means a misconfigured key, not exhaustion, and should not silently reroute traffic.

So the parsers return `true` for unknown fields, missing arrays, non-numeric values and unparseable
bodies. The failure mode of a stale parser is "the fallback stopped working", never "the agent stopped
working". Results are cached (60s) and concurrent probes are deduplicated, so the added latency in
steady state is zero and the added cost is one HTTP request per provider per minute.

## 5. Why the failover targets a *model*, not an error handler

An earlier experiment wired an existing error-driven fallback extension (`pi-provider-fallback`) to
this router. Two things went wrong, both structural:

1. **It bypassed the router.** Error handlers read `ctx.model` — the *selected* model — which is the
   virtual model `judge/auto`. They then call `pi.setModel(<physical model>)`. From that point the
   session runs on a physical model and the router is out of the loop. The handler also cannot tell
   which physical model actually failed: it sees `judge/auto`.
2. **It processed the prompt twice.** The handler re-sends the failed user message while pi's own
   retry logic also re-issues the turn, and the model swap lands between the retries. Result: two
   identical answers for one prompt. In a coding session, where the failed turn may already have
   executed tools, that is a correctness problem.

Tested alternative: point the fallback at **another virtual model** (a second one that pins routes to
the substitute provider). `pi.setModel` accepts virtual models, so the selection stays virtual and the
router keeps participating in a degraded mode. This works, and is the right shape if you prefer an
existing package over custom code — but it inherits the package's error classification, which is
regex-based and misses the quota message above.

Doing it inside the router avoids both problems: the decision happens before dispatch, it knows the
exact model being replaced, and no prompt is ever re-sent.

## 6. Why the swap happens once, after the first edit

Model switches forfeit the warm prompt cache, and on long contexts the re-read is the dominant cost.
So the router takes at most one switch per session: the planner explores and plans, and as soon as it
has written something successfully, the implementer takes over. `retry` explicitly stays on the model
that answered, with its existing cache, rather than re-deciding.

The same reasoning puts compaction (`reason: "direct"`) on the implementation model: it is output-heavy
work on a large context, which is exactly the profile the implementation tier is priced for.

## 7. Testing strategy

Two layers, because the two failure modes are different.

**Unit tests** cover the parsers, with fixtures that reproduce the vendors' real envelopes (string
balances, multiple currencies, `TIME_LIMIT` vs `TOKENS_LIMIT`, missing fields, HTML error pages).
These are the tests that will fail when a vendor changes something, which is why they assert the
fail-open behaviour explicitly rather than only the happy path.

**End-to-end tests** run the real extension through a headless pi session with the probe threshold
forced, and read the dispatched model from the JSON event stream. The four cases that matter:

| Forced condition | Expected |
|---|---|
| defaults | primary planner, primary implementer |
| `MAX_QUOTA_PERCENT=0` (z.ai exhausted) | substitute planner, primary implementer |
| `MIN_BALANCE_USD=999999` (DeepSeek exhausted) | primary planner, substitute implementer |
| `PROBE_TIMEOUT_MS=1` (probe fails) | primary for both — fail open |

Running the same four by hand after any change is the cheapest possible regression check.

## 8. Known limits

- **No chain.** One substitute per primary. Chaining is easy to add but multiplies the states to reason
  about for a case (both providers down) that has not been observed.
- **Two providers probed.** z.ai and DeepSeek were the ones with a readable account state. OpenRouter
  exposes `/credits`, Moonshot exposes a balance endpoint, and others are already implemented in
  `pi-usage-bars` — extending `PROBED_PROVIDERS` and adding a parser is the whole change.
- **Probe data ages.** The fallback map and the price parity between primary and substitute have to be
  re-checked when vendors release models. It is a constant, not a service, on purpose.
- **The judge is a single point of failure** for routing quality, mitigated by falling back to the
  cheap planner whenever it is unavailable or answers unexpectedly.
