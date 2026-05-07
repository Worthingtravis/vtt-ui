# Cloudflare Queues Migration Plan: VOD Submission Pipeline

## Current State

`/api/submit_vod` lives entirely on serve.py (lines 5595-5677). No Pages Function exists for this route yet. Flow:

```
Browser → Cloudflare Tunnel → serve.py /api/submit_vod
  parse_submission_url()          (pure regex, fast)
  already_processed()             (scans creators/ .meta.json files)
  resolve_submission()            (Twitch Helix + vodvod.top network calls)
  vodvod_downloader.start_download()
  pipeline_jobs.start_vodvod_chain_job()
  → 200 {status: "queued", job_id}
```

Failure modes: serve.py down = 502. Spike of submissions = all hit the single tunnel sequentially. No per-user rate limiting. No persistent backlog.

## Cloudflare Queues: Current Limits (verified 2026-05-07)

| Property | Value |
|---|---|
| Max message size | 128 KB (our messages ~800 bytes) |
| Max queue depth | 25 GB |
| Message retention, Free plan | 24 hours (non-configurable) |
| Message retention, Paid plan | Up to 14 days (configurable) |
| Throughput per queue | 5,000 messages/second |
| Max pull batch size | 100 messages |
| Pull visibility timeout | Default 30s, max 12 hours |
| Delivery guarantee | At-least-once |
| Free operations/day | 10,000 ops/day |
| Paid included ops/month | 1,000,000 ops/month |
| Paid overage cost | $0.40 per million ops |
| Ops counted per message | 3 (write + read + delete) |
| Pages Functions as consumer | NOT supported. Must be a separate Worker. |
| Pages Functions as producer | Supported via `[[queues.producers]]` binding |

**Cost estimates** (paid tier, $0.40/M ops, 3 ops/msg, 1M ops/month included):
- 100 submissions/day → ~90k ops/month → $0
- 1,000/day → ~900k ops/month → $0
- 10,000/day → ~9M ops/month → ~$3.20/month overage

## Topology

**One queue, `vtt-submissions`, with a `kind` field for future expansion.**

Reasons: renders + scans are managed by serve.py's in-process `jobs.py`; only public submissions need edge-side durability. A `kind` field on the message keeps the door open for later kinds without a topology change.

**DLQ:** create a second queue `vtt-submissions-dlq`. Permanent failures (bad URL, parse failure, 3+ retries) get acked into the DLQ for inspection. Without DLQ, "I submitted it but nothing happened" is undebuggable.

## Message Schema

```typescript
interface SubmissionMessage {
  kind: "submit_vod";
  submission_id: string;        // uuid4 — tracking id returned to user
  raw_url: string;
  creator: string | null;       // streamer_login, null until resolved
  stream_id: string | null;
  twitch_vod_id: string | null;
  m3u8_url: string | null;
  name: string | null;
  title: string | null;
  submitter_sub: string;        // OAuth sub
  submitter_login: string | null;
  requested_at: string;         // ISO-8601 UTC
}
```

~500-600 bytes serialized. Well within 128 KB.

## Producer: New Pages Function

`site/functions/api/submit_vod/index.ts`:

1. Auth-gate via `vtt_session` cookie (existing `unpackSigned` lib).
2. Edge regex pre-validation (cheap reject of garbage URLs).
3. Tunnel hop to new `GET /api/submit_vod/check?url=...` on serve.py — runs `parse_submission_url + already_processed` only. If `already_processed`, return 200 immediately.
4. On cache miss: generate UUID `submission_id`, build message, `env.VTT_SUBMISSIONS.send(message)`.
5. Return `202 { status: "submitted", submission_id }`.

Does NOT call `resolve_submission`, `start_download`, or `start_vodvod_chain_job`.

### wrangler.toml

```toml
[[queues.producers]]
queue = "vtt-submissions"
binding = "VTT_SUBMISSIONS"
```

### New endpoint on serve.py: `/api/submit_vod/check`

Read-only, runs only `parse_submission_url + already_processed`. Returns `{ok, status, parsed | creator+basename+deep_link}`. Add at line ~5595.

## Consumer: HTTP Pull Daemon Thread

**Decision: HTTP pull consumer in serve.py, not a Worker push consumer.**

Push consumer = third hop, new deploy artifact, mixed local-emulation pain. serve.py already runs background threads (jobs.py worker pool) — adding one more for queue polling is the obvious fit.

### `queue_consumer.py`

```python
POLL_INTERVAL_S = 5
BATCH_SIZE = 10
VISIBILITY_TIMEOUT_MS = 120_000   # 2 min; must exceed resolve_submission worst case

def _consumer_loop():
    while True:
        try:
            messages = _pull_batch(BATCH_SIZE, VISIBILITY_TIMEOUT_MS)
            if not messages:
                time.sleep(POLL_INTERVAL_S); continue
            acks, retries = [], []
            for msg in messages:
                lease_id = msg["lease_id"]
                try:
                    body = json.loads(base64.b64decode(msg["body"]))
                    _process_submission(body)
                    acks.append({"lease_id": lease_id})
                except _AlreadyProcessed:
                    acks.append({"lease_id": lease_id})       # idempotent
                except _TransientError as e:
                    retries.append({"lease_id": lease_id, "delay_seconds": 30})
                except Exception as e:
                    acks.append({"lease_id": lease_id})       # → DLQ via attempts
            _ack_batch(acks=acks, retries=retries)
        except Exception:
            time.sleep(POLL_INTERVAL_S)

def _process_submission(body):
    import submit_intake, vodvod_downloader, pipeline_jobs
    parsed = {"kind": body["kind_url"], "twitch_vod_id": body.get("twitch_vod_id"),
              "stream_id": body.get("stream_id"), "raw": body["raw_url"]}
    hit = submit_intake.already_processed(parsed, creators_dir=CREATORS_DIR)
    if hit:
        raise _AlreadyProcessed(hit)
    resolved = submit_intake.resolve_submission(parsed, creators_dir=CREATORS_DIR)
    dl_jid = vodvod_downloader.start_download(...)         # dedupes by stream_id
    chain_jid = pipeline_jobs.start_vodvod_chain_job(...)  # dedupes by download_job_ids
    _write_submission_status(body["submission_id"], {...})
```

**Note:** Queue `body` is base64-encoded; decode before `json.loads`.

### `submission_status_store.py`

JSON sidecar at `creators/_submissions/<submission_id>.json`. Maps submission_id to job status. Read by serve.py `/api/submit_vod/status?id=<submission_id>` for client polling.

## Idempotency Analysis (at-least-once delivery)

Three layers of dedup:
1. `already_processed()` — reads `.meta.json` sidecars, returns early if transcript exists.
2. `vodvod_downloader.start_download()` `find_existing_job` — dedupes by stream_id.
3. `start_vodvod_chain_job` — dedupes by download_job_ids (patched 2026-05-07).

**Verdict: idempotency survives at-least-once.** stream_id is a stronger key than submission_id — even two different users submitting the same stream download once.

**One gap:** if serve.py restarts between download-complete and chain-start, the in-memory `find_existing_job` check loses sight of the completed download. Pre-existing behavior, not a regression.

## Status Polling Architecture

**Phase 1 (recommended):** client polls `/api/submit_vod/status?id=<submission_id>` on serve.py. Tunnel hop per poll.

**Phase 2 (later):** KV namespace `vtt-submissions-status` written by consumer, read by Pages Function. No tunnel hop. Defer until volume justifies it.

**Backpressure:** Queues REST API doesn't expose cheap depth. Phase 1 returns `202` with no position estimate. If needed: Durable Object counter or KV counter, defer.

## Auth on the Queue

Queue binding is Cloudflare-internal — only the Pages Function with `VTT_SUBMISSIONS` binding can produce. Not accessible from public internet.

Pull consumer needs `CF_QUEUE_TOKEN` (queues:read + queues:write scoped to vtt-submissions), `CF_ACCOUNT_ID`, `CF_SUBMISSIONS_QUEUE_ID` in `.env.local`.

## DLQ Configuration

Create `vtt-submissions-dlq`. Configure `vtt-submissions` consumer with `max_retries=3, dead_letter_queue=vtt-submissions-dlq`.

For the pull consumer: `max_retries` is consumer-controlled via `attempts` field on each message. Recommended:
- `attempts < 3` + transient: retry with `delay_seconds=30`
- `attempts >= 3` or permanent: ack + write to `creators/_submissions/failed/` for inspection

## Migration Runbook

### Phase 0 — Prereq

- [ ] `wrangler queues create vtt-submissions`
- [ ] `wrangler queues create vtt-submissions-dlq`
- [ ] Capture queue ID via `wrangler queues list` → add `CF_SUBMISSIONS_QUEUE_ID` to `.env.local`
- [ ] Create scoped API token, add as `CF_QUEUE_TOKEN`
- [ ] Add `[[queues.producers]]` to `site/wrangler.toml`
- [ ] Deploy `queue_consumer.py` with no-op `start_consumer_thread()` if `CF_SUBMISSIONS_QUEUE_ID` is unset

### Phase 1 — Shadow mode

- [ ] Add `/api/submit_vod/check` to serve.py
- [ ] Create `site/functions/api/submit_vod/check.ts`
- [ ] Create `site/functions/api/submit_vod/index.ts` that BOTH enqueues AND calls original `/api/submit_vod` for backward compat
- [ ] Smoke test: submit a real VOD, verify queue message via `wrangler queues pull vtt-submissions --count=1 --no-ack`, verify direct path still works
- [ ] Run 48h, verify consumer finds `already_processed` on everything

### Phase 2 — Cutover

- [ ] Enable `start_consumer_thread()` in serve.py startup
- [ ] Pages Function stops calling original `/api/submit_vod`, returns `{status: "submitted", submission_id}`
- [ ] Add `/api/submit_vod/status` to serve.py
- [ ] Update UI submit flow to poll new status endpoint
- [ ] Verify restart survival: kill serve.py mid-message, confirm consumer resumes

### Phase 3 — Cleanup

- [ ] Remove old `/api/submit_vod` monolith handler (keep `/check` and `/status`)
- [ ] Remove tunnel routing for old endpoint if any

### Phase 4 — Wire x402

- [ ] Insert payment verification between auth + dedup in Pages Function (per `x402_integration_plan.md`)
- [ ] Add `x402_paid: bool` audit field to message

## Rollback

If consumer breaks:
1. Re-enable shadow mode: Pages Function calls direct path alongside enqueue. ~60s deploy.
2. Drain queue: messages survive in queue (24h free / 14d paid) — process when consumer is fixed. No loss.
3. Crash loop: bump `visibility_timeout_ms` to 12h to give yourself a fix window. Or `DISABLE_QUEUE_CONSUMER=1` env flag.

## File Inventory

### New

| Path | Purpose |
|---|---|
| `site/functions/api/submit_vod/index.ts` | Auth + edge dedup + enqueue + 202 |
| `site/functions/api/submit_vod/status.ts` | Proxy to serve.py status |
| `video-to-text/queue_consumer.py` | Python pull-consumer thread |
| `video-to-text/submission_status_store.py` | JSON sidecar r/w |

### Modified

| Path | Change |
|---|---|
| `site/wrangler.toml` | Add `[[queues.producers]]` |
| `video-to-text/serve.py` | Add `/check` and `/status` handlers; keep `/submit_vod` during shadow; call `start_consumer_thread()` at boot |

## Open Questions

**Q1.** Free vs Paid Queues plan. Free caps retention at 24h. serve.py multi-day outage = silent drops. Workers Paid is $5/mo for 14-day retention. Upgrade?

**Q2.** Status polling: Phase 1 (tunnel hop) is simple. Phase 2 (KV) is lower latency. When to do Phase 2, if ever?

**Q3.** Single queue with `kind` field, or split queues for future render/scan kinds. Decide before adding the second kind.

**Q4.** DLQ side-effect: Discord/notifications.jsonl entry when a submission permanently fails so you can manually resubmit?

**Q5.** Backpressure UI — return queue position from day one (Durable Object counter), or just 202 with no estimate?

**Q6.** Visibility timeout: 2 min vs 5 min? `resolve_submission` worst case maybe 30s, but vodvod can hang.

**Q7.** `CF_QUEUE_TOKEN` scope: per-queue (rotation hassle but minimum privilege) vs account-wide?
