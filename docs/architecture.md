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

## 6. Why the tier ratchets, and the swap happens once per phase

Model switches forfeit the warm prompt cache, and on long contexts the re-read is the dominant cost.
The naive reading of that fact is "judge rarely". The router does the opposite, and the reason is
that the two costs are not the same size: a Jev call is a few hundred tokens, while a cold cache on a
large context is the whole prefix at full input price. So the judge is re-read on **every new user
message** — cheap, and the only moment the goal can actually change — while the **tier ratchets**:

```
tier = high if the session has ever read complex, else low if p(complex) >= threshold
```

Once a session is called complex it stays complex. That is what makes frequent judging affordable: a
switch only happens when the verdict really changed, and it only ever changes in one direction. Real
work drifts from simple to complex far more often than the reverse, and over-provisioning is the safe
side anyway, so a ratchet matches both the workload and the economics. It also removes the failure
mode the naive design would have: a session that flaps between the cheap and the strong model every
few turns, never letting either cache warm.

The phase swap stays once per session. The planner explores and plans; as soon as it has written
something successfully, the implementer takes over — the strong model if the session reached the
complex tier, `exec` otherwise. `retry` explicitly stays on the model that answered, with its
existing cache, rather than re-deciding. Compaction (`reason: "direct"`) stays on `exec`: it is
output-heavy work on a large context, which is exactly the profile the implementation tier is priced
for, whatever tier the session reached.

A tool continuation is never re-judged. It cannot change the goal, so scoring it would only pay the
classifier for the same answer; pi already labels the moment a new goal can appear — the first request
after a user message comes in as `reason: "user"`, and every other request in the turn as
`reason: "continuation"` — so the router keys off that instead of diffing messages itself.

One consequence of the design is worth recording: because the choice is sticky, the session state
stores the **tier** and the **phase**, not the resolved model. Storing the model would mean that a
`/judge-models` override could not take effect until the next session, which is the opposite of what
an override is for. Storing the tier means every request re-resolves the role from tier and phase, so
a change lands on the very next request; the legacy `role` and `model` fields keep older sessions
working.

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

## 8. Observability: why provider indicators go blind

Every provider-indicator extension has the same shape: read the **selected** model's provider,
map it to a vendor, poll that vendor's quota endpoint, draw it in the footer. That works because the
selected model *is* the serving model.

A virtual model breaks that assumption. The selected provider is `judge`, which maps to no vendor, so
the automatic indicators show nothing. It is not a bug in those extensions — it is a category the
virtual-model layer introduced, and the mapping simply has no entry for it. Manual paths survive:
`pi-usage-bars` still lists every provider in its `/usage` panel and each can be opened by hand.

The router fills the automatic path itself, because it is the only component that knows both halves:

- **what it dispatched** — after `withFallback` resolves, the target is provider-qualified
  (`deepseek/deepseek-flash`), so a model id that exists on several providers is never ambiguous;
- **what it probed** — the probe now returns `{ usable, detail }` instead of a boolean, where
  `detail` is already the human string (`USD 42.00`, `tokens 32%/6%`). A boolean would have thrown
  away the number at exactly the point it was read.

Both go into a footer status via `ctx.ui.setStatus`, refreshed on every dispatch and every probe
outcome. That keeps the useful part of a usage bar — the reading — without a second polling path.

Usage accounting is separate and deliberately narrower. The router records the token counts of its
own judge calls from `ClassifierResult.usage`, into a persisted per-day store. It cannot see calls
made by other extensions, because those use their own HTTP clients; and it cannot report credits,
because TypeSafe's public surface is just `POST /v1/systemone` and `GET /v1/models`. Probes of a
dozen plausible account/usage paths all return 404. The honest answer for "how many credits are
left" is the vendor console; the honest answer for "what did routing cost" is this store.

The session cost deserves one more note, because the built-in footer reports it as a single number.
That number is a sum over every model used in the session at catalog prices — and the providers in
this setup do not bill the same way. DeepSeek is prepaid: those dollars are real and the balance
falls. z.ai is a plan measured in quota percentages: those dollars are a list-price counterfactual,
and the binding constraint is the window, not the wallet. Neither the footer nor a vendor indicator
can label that difference, because the selected provider is the virtual one. Splitting the same
numbers per provider is the cheapest way to make the consumption legible, which is why the status
line ends with `sess ds $0.67 zai $0.13` instead of one total.

One more design note on the status line: the probe used to return a boolean plus a detail string.
It now returns structured readings — quota windows with percentages and reset times, a balance with
its currency — and the formatting lives in a separate module. A boolean would have thrown the number
away exactly where it was read, and a detail string would have locked the display into the parser.

A last detail that only shows up once the router can be bypassed: selecting a physical model by hand
stops `route()` from running, so a status line updated only from routing decisions would freeze on
the last dispatched model. The line therefore also refreshes on `turn_end` and follows `model_select`.
Cost tracking has to survive being switched off, otherwise it only reports the happy path.

## 9. Known limits

- **No chain.** One substitute per primary. Chaining is easy to add but multiplies the states to reason
  about for a case (both providers down) that has not been observed.
- **Two providers probed.** z.ai and DeepSeek were the ones with a readable account state. OpenRouter
  exposes `/credits`, Moonshot exposes a balance endpoint, and others are already implemented in
  `pi-usage-bars` — extending `PROBED_PROVIDERS` and adding a parser is the whole change.
- **Probe data ages.** The fallback map and the price parity between primary and substitute have to be
  re-checked when vendors release models. It is a constant, not a service, on purpose.
- **The judge is a single point of failure** for routing quality, mitigated by falling back to the
  cheap planner whenever it is unavailable or answers unexpectedly.
