/**
 * /api/events — server-side filter over the public xcorr-event index.
 *
 * Reads ``events/index.json`` (gzipped on the wire when payload > 500 rows)
 * once per isolate, filters in-memory, joins twitch_vod_id + title from
 * ``vods/index.json`` so each row can deep-link to twitch.tv at the right
 * second. Mirror of the shape returned by /api/search so the frontend can
 * reuse renderHits().
 *
 * Query params:
 *   event=match_start|match_end|match_queued|gen_popped|survivor_on_hook
 *         (display name from EVENT_LABELS) OR the internal class name
 *         (match_intro|match_result|lobby_alarm|generator_complete|survivor_hooked).
 *         Repeatable (?event=match_start&event=match_end).
 *   creator=<name>          — filter to one creator
 *   vod=<creator>/<basename> — filter to one VOD
 *   min_score=<float>       — drop hits with peak_score < min_score
 *   limit=<int>             — cap results (default 200, max 1000)
 *
 * 503 with explicit error if events/index.json hasn't been published yet
 * — silent empty would mask the publish step missing.
 */
interface Env { PUBLIC_BUCKET: R2Bucket }

interface EventRow { c: string; b: string; e: string; t: number; s: number }
interface EventsIndex {
  schema_version?: number;
  generated_at?: string;
  n_events?: number;
  n_vods?: number;
  per_class_counts?: Record<string, number>;
  classes?: string[];
  events?: EventRow[];
}
interface VodMetaRow { c: string; b: string; tv: string; title?: string }
interface VodMetaIndex { vods?: VodMetaRow[] }

// Display name <-> internal class. Mirror of the EVENT_LABELS map in
// index.html. Keeping both in sync is a tiny manual coupling — only 5
// rows, both files documented as the source of truth for each side.
const DISPLAY_TO_CLASS: Record<string, string> = {
  match_start: "match_intro",
  match_end: "match_result",
  match_queued: "lobby_alarm",
  gen_popped: "generator_complete",
  survivor_on_hook: "survivor_hooked",
};
const CLASS_NAMES = new Set(Object.values(DISPLAY_TO_CLASS));

let _eventsCache: { fetched: number; data: EventsIndex } | null = null;
let _vodMetaCache: { fetched: number; data: VodMetaIndex } | null = null;
const TTL = 60_000;

async function loadIndex<T>(bucket: R2Bucket, key: string,
                            cache: { fetched: number; data: T } | null,
                            set: (c: { fetched: number; data: T }) => void): Promise<T | null> {
  if (cache && (Date.now() - cache.fetched) < TTL) return cache.data;
  const obj = await bucket.get(key);
  if (!obj) return null;
  let stream: ReadableStream<Uint8Array> = obj.body;
  if (obj.httpMetadata?.contentEncoding === "gzip") {
    stream = stream.pipeThrough(new DecompressionStream("gzip"));
  }
  const text = await new Response(stream).text();
  const data = JSON.parse(text) as T;
  set({ fetched: Date.now(), data });
  return data;
}

function resolveEventClass(token: string): string | null {
  const t = token.trim().toLowerCase();
  if (!t) return null;
  if (DISPLAY_TO_CLASS[t]) return DISPLAY_TO_CLASS[t];
  if (CLASS_NAMES.has(t)) return t;
  return null;
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const wantedClasses = new Set<string>();
  for (const raw of url.searchParams.getAll("event")) {
    const cls = resolveEventClass(raw);
    if (cls) wantedClasses.add(cls);
  }
  const creator = (url.searchParams.get("creator") || "").trim();
  const vodFilter = (url.searchParams.get("vod") || "").trim();  // "<c>/<b>"
  const minScoreRaw = url.searchParams.get("min_score");
  const minScore = minScoreRaw ? Number(minScoreRaw) : 0;
  const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") || 200)));

  const [eventsIdx, metaIdx] = await Promise.all([
    loadIndex<EventsIndex>(env.PUBLIC_BUCKET, "events/index.json",
      _eventsCache, (c) => { _eventsCache = c; }),
    loadIndex<VodMetaIndex>(env.PUBLIC_BUCKET, "vods/index.json",
      _vodMetaCache, (c) => { _vodMetaCache = c; }),
  ]);

  if (!eventsIdx) {
    // Don't silently return empty. The user needs to know the publish
    // step is missing — they call /api/regenerate_events_index on
    // serve.py to fix it.
    return Response.json(
      {
        error: "events/index.json not yet published — POST /api/regenerate_events_index on serve.py",
        events: [], n_total: 0,
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  const tvByVod = new Map<string, VodMetaRow>();
  for (const r of (metaIdx?.vods || [])) tvByVod.set(`${r.c}/${r.b}`, r);

  const all = eventsIdx.events || [];
  const hits: Array<{ kind: "event"; rec: EventRow & { tv?: string; title?: string } }> = [];
  for (const row of all) {
    if (wantedClasses.size && !wantedClasses.has(row.e)) continue;
    if (creator && row.c !== creator) continue;
    if (vodFilter && `${row.c}/${row.b}` !== vodFilter) continue;
    if (row.s < minScore) continue;
    const meta = tvByVod.get(`${row.c}/${row.b}`);
    const enriched: EventRow & { tv?: string; title?: string } = meta
      ? { ...row, tv: meta.tv, title: meta.title }
      : { ...row };
    hits.push({ kind: "event", rec: enriched });
  }

  // Sort: highest score first (most confident hits up top). Stable
  // secondary by (creator, basename, t) for deterministic pagination.
  hits.sort((a, b) =>
    b.rec.s - a.rec.s ||
    a.rec.c.localeCompare(b.rec.c) ||
    a.rec.b.localeCompare(b.rec.b) ||
    a.rec.t - b.rec.t,
  );

  return Response.json(
    {
      filters: {
        events: [...wantedClasses],
        creator,
        vod: vodFilter,
        min_score: minScore,
      },
      classes: eventsIdx.classes || [],
      per_class_counts: eventsIdx.per_class_counts || {},
      generated_at: eventsIdx.generated_at,
      n_total: hits.length,
      hits: hits.slice(0, limit),
    },
    { headers: { "cache-control": "public, max-age=15" } },
  );
};
