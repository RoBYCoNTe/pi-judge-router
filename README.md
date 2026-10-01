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

Three observations, all measured on a real workload (187 sessions, 14.5B tokens) rather than
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
| `JUDGE_ROUTER_STATUS` | `full` | footer verbosity: `full`, `compact`, `off` |
| `JUDGE_ROUTER_USAGE_FILE` | `<agent dir>/judge-router-usage.json` | where the judge-usage counter is stored |

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

## Visibility

A virtual model is invisible to provider-based indicator extensions, and for a good reason: they
read the **selected** model's provider to decide what to poll. Selected here is `judge`, which matches
no vendor, so their automatic indicators go quiet. (Manual paths still work — the `/usage` panel of
`pi-usage-bars` lists every provider and can be opened for any of them.)

The router closes that gap in three places.

**A footer status line**, updated on every dispatch and every probe:

```
→ deepseek/deepseek-flash · 5h ███░░░░░ 32% ⟳1h12m · W ░░░░░░░░ 6% ⟳3d · ds $45.94 · sess ds $0.67 zai $0.13
```

- the **provider-qualified model actually dispatched**, so a `glm-5.3-flash` is never ambiguous
  between z.ai and Fireworks;
- each probe reading, with a bar and a reset countdown for quota windows;
- the **session cost split per provider**. This one matters: the built-in footer shows a single
  cumulative cost for the whole session, which mixes providers that do not bill the same way — a
  prepaid dollar balance and a plan measured in quota percentages. Split apart, it is readable.

`JUDGE_ROUTER_STATUS=compact` drops the bars and the split; `off` disables the line entirely.

**`/usage-breakdown`**, a per-model and per-provider table for the current session:

```
model                              calls        in       out   cache-r      cost
deepseek/deepseek-flash              223    470.3k    232.0k     41.9M    $0.671
zai/glm-5.3-flash                     41    304.0k      9.1k      2.7M    $0.130
TOTAL                                264    774.3k    241.1k     44.5M    $0.801
```

**`/jev-usage`**, a command that reports the judge calls this router made:

```
since 2026-10-01: 42 calls, in 18.2k, out 1.4k · today: 3 calls, in 1.1k, out 90
file: ~/.pi/agent/judge-router-usage.json
```

The counter is persisted and accumulates across sessions. Scope is deliberate and worth stating:
it counts **only the calls this router makes**. Calls made by other extensions (a gate judging every
tool call, for instance) go through their own HTTP clients and are invisible here. TypeSafe's API
exposes no balance or aggregated usage endpoint — `POST /v1/systemone` and `GET /v1/models` are the
whole surface — so the authoritative credit balance stays in the vendor console.

## Layout

```
src/judge-router.ts        the extension: virtual model, routing rules, probe cache, usage, pi wiring
src/provider-probe.ts      endpoints, payload parsers and the probe itself — no pi imports
src/format.ts              bars, token counts, money, countdowns — no pi imports
src/session-report.ts      session aggregation and the report table — no pi imports
src/usage-store.ts         persistent judge-usage counter — no pi imports
tests/provider-probe.test.ts
tests/format.test.ts
tests/session-report.test.ts
tests/usage-store.test.ts
docs/architecture.md       the decisions, the measurements and the trade-offs
```

Every module except the extension itself has no dependency on pi, so they are unit-testable in
isolation and reusable from any other extension.

## Development

```bash
bun test          # 59 unit tests, no network, no credentials
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
