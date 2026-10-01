# pi-judge-router

A [pi](https://github.com/earendil-works/pi) virtual model that picks the model per request with a
**calibrated judge** instead of a heuristic, and **fails over to an equivalent model on another
provider when the primary runs out of credit**.

One model to select — `judge/auto` — three decisions underneath:

| Situation | Model |
|---|---|
| First request of a session, judge rates the task ordinary | cheap planner |
| First request of a session, judge rates the task complex | strong planner |
| After the first successful `edit`/`write` | implementation model |
| `retry`, after a failure | the model that answered (prompt cache survives) |
| Compaction and other out-of-loop requests | implementation model |
| Primary provider is out of credit/quota | its Fireworks equivalent |

Defaults target `zai/glm-5.3-flash`, `zai/glm-5.3` and `deepseek/deepseek-flash`, with
`fireworks/accounts/fireworks/models/*` as the substitutes. All of it is configurable.

## Why this exists

Three observations, all measured on a real workload (187 sessions, $354 of model spend) rather than
assumed:

1. **Premium models were 37% of the bill and mostly avoidable.** Most turns are ordinary work; the
   expensive tier was being selected by hand and then kept for the whole session.
2. **pi will not retry a credit error.** Its retry classifier treats *quota* errors (`insufficient_quota`,
   `out of budget`, `quota exceeded`, `available balance`, `billing`, `usage limit`) as **terminal**, so
   `route(reason: "retry")` never fires for them and error-driven fallback extensions never see them.
   The only reliable way to react is to check *before* dispatching.
3. **Switching models costs a prompt cache miss.** So the router switches as little as possible: once,
   after planning succeeds, and never on a retry.

The result is a router that treats "which model" as an economic decision with two inputs: task
difficulty (a judgement, so a judge model) and provider availability (a fact, so code).

## What this is not

It is **not** a replacement for existing fallback extensions, and not a claim of novelty in
model routing. It is a reference implementation of one specific pattern — judge-based routing plus
proactive credit probing — written to be read alongside the article. Where a general fallback package
fits better, it says so (see [Related work](#related-work)).

## Install

As a local package (the repository is the source of truth, nothing is copied):

```bash
pi install /path/to/pi-judge-router
```

Then select it:

```bash
pi --model judge/auto
```

Or set it as the default in `~/.pi/agent/settings.json`:

```json
{ "defaultProvider": "judge", "defaultModel": "auto" }
```

Requires credentials for the models you configure. The default set needs a TypeSafe key for the
judge (`TYPESAFE_API_KEY`), z.ai and DeepSeek for the primaries, and Fireworks for the substitutes.

## Configuration

Everything is environment variables, all optional:

| Variable | Default | Meaning |
|---|---|---|
| `JUDGE_ROUTER_JUDGE` | `typesafe/jev-latest` | classifier model that rates the task |
| `JUDGE_ROUTER_CHEAP` | `zai/glm-5.3-flash` | ordinary planning |
| `JUDGE_ROUTER_STRONG` | `zai/glm-5.3` | complex planning |
| `JUDGE_ROUTER_IMPLEMENT` | `deepseek/deepseek-flash` | implementation and compaction |
| `JUDGE_ROUTER_COMPLEX_THRESHOLD` | `0.3` | `p(complex)` at or above which the strong model is used |
| `JUDGE_ROUTER_MIN_BALANCE_USD` | `1` | DeepSeek balance below which the provider counts as exhausted |
| `JUDGE_ROUTER_MAX_QUOTA_PERCENT` | `95` | z.ai token quota at or above which it counts as exhausted |
| `JUDGE_ROUTER_PROBE_TTL_MS` | `60000` | how long a probe result is trusted |
| `JUDGE_ROUTER_PROBE_TIMEOUT_MS` | `3000` | HTTP timeout for a probe |

Model references are `provider/id`, split on the **first** slash only, so ids such as
`accounts/fireworks/models/glm-5p3-flash` work.

### The fallback map

`FALLBACKS` in [`src/provider-probe.ts`](src/provider-probe.ts) maps a primary to its substitute:

```ts
"zai/glm-5.3-flash": { provider: "fireworks", id: "accounts/fireworks/models/glm-5p3-flash" },
"zai/glm-5.3":       { provider: "fireworks", id: "accounts/fireworks/models/glm-5p3" },
"deepseek/deepseek-flash": { provider: "fireworks", id: "accounts/fireworks/models/deepseek-v4p1-flash" },
```

This is **data, not logic**: it goes stale as vendors release models, so it is one readable constant
rather than a config system. Prices for these pairs are essentially identical (the DeepSeek
substitute is slightly cheaper than the primary), so a failover is a cache miss, not a bill shock.

Adding a provider means adding an entry, a parser, and the provider id to `PROBED_PROVIDERS`.

## How the probe behaves

`true` means "use the primary". So does *anything unexpected*:

| Situation | Result |
|---|---|
| balance/quota readable and healthy | primary |
| provider explicitly reports exhaustion | substitute |
| HTTP error, timeout, changed JSON shape, missing key | **primary** (fail open) |
| substitute not in the catalog | primary, with a notification |

Fail-open is deliberate. The probe sits in front of every request; a changed vendor endpoint must
degrade the router to "no fallback", never to a broken agent. Probe results are cached for
`JUDGE_ROUTER_PROBE_TTL_MS` and concurrent probes for the same provider are deduplicated, so the
steady-state cost is one HTTP request per provider per minute.

## Layout

```
src/judge-router.ts      the extension: virtual model, routing rules, probe cache, pi wiring
src/provider-probe.ts    endpoints, payload parsers and the probe itself — no pi imports
tests/provider-probe.test.ts
docs/architecture.md     the decisions, the measurements and the trade-offs
```

`src/provider-probe.ts` has no dependency on pi, so it is unit-testable in isolation and reusable
from any other extension.

## Development

```bash
bun test          # 18 unit tests, no network, no credentials
```

The extension is loaded in place by `pi install /path/to/pi-judge-router`, so editing the repository
*is* editing the live extension: reload pi (`/reload` or restart) to pick up changes.

If a vendor changes a payload, exactly two functions need updating — `deepseekHasCredit` or
`zaiHasQuota` — and the tests will tell you which way. If a vendor removes an endpoint entirely, the
probe throws and the router fails open on its own.

## Trade-offs

- **TTL staleness.** Credit can run out inside the cache window; the next request fails and the
  following one fails over. A shorter TTL costs more requests.
- **The judge is a model call.** It runs once per session, before the first token, and adds its
  latency there. Its cost is negligible next to one mis-routed turn.
- **Two vendors, one failure mode each.** The router knows z.ai and DeepSeek. Anything else is
  passed through unprobed.
- **The substitute is a single target**, not a chain. Chaining (primary → substitute → third) is a
  small change to `withFallback`, at the cost of more state to reason about.

## Related work

- [`pi-jev`](https://github.com/y0usaf/pi-jev) — judge gate, output judge and a `jev_ask` tool. It
  composes with this router; they are independent code paths.
- [`pi-provider-fallback`](https://github.com/37/pi-provider-fallback),
  [`pi-auto-fallback`](https://github.com/…), [`pi-fallback-provider`](https://www.npmjs.com/package/pi-fallback-provider) —
  error-driven fallback. Better than this router at reacting to *transient* failures.
- [`pi-usage-bars`](https://github.com/hknet/pi-usage-bars) — quota and balance indicators for many
  providers; the endpoints used here were cross-checked against it.
- pi's own [`jev-router.ts` example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/jev-router.ts) —
  the judge-based routing idea this builds on.

## License

MIT
