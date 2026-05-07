/**
 * /api/search — server-side search across clips + VOD transcripts.
 * Loads the gzipped indexes from R2 once per isolate and filters
 * in-memory. Page calls this instead of fetching the 28 MB / 3.6 MB
 * indexes directly.
 *
 * Query params: q, creator?, mode?=all|clip|vod, limit?=200
 */
interface Env {
  PUBLIC_BUCKET: R2Bucket;
}
interface ClipRecord {
  id: string; creator: string; title?: string; text?: string;
  duration?: number; source_vod?: string; source_start?: number;
  source_end?: number; created_at?: string; url?: string;
  meta_url?: string; vtt_url?: string;
}
interface VodSegment { c: string; b: string; t: number; d: number; x: string;
                       tv?: string; title?: string }
interface ClipIndex { clips?: ClipRecord[]; n_clips?: number }
interface VodIndex { segments?: VodSegment[]; n_vods?: number; n_segments?: number }
interface VodMetaRow { c: string; b: string; tv: string; title?: string;
                       downloaded_at?: string }
interface VodMetaIndex { vods?: VodMetaRow[]; n_vods?: number }

let _clipCache: { fetched: number; data: ClipIndex } | null = null;
let _vodCache: { fetched: number; data: VodIndex } | null = null;
let _metaCache: { fetched: number; data: VodMetaIndex } | null = null;
const TTL = 60_000;

async function loadIndex<T>(bucket: R2Bucket, key: string,
                            cache: { fetched: number; data: T } | null,
                            set: (c: { fetched: number; data: T }) => void): Promise<T> {
  if (cache && (Date.now() - cache.fetched) < TTL) return cache.data;
  const obj = await bucket.get(key);
  if (!obj) throw new Error(`R2 missing: ${key}`);
  let stream: ReadableStream<Uint8Array> = obj.body;
  if (obj.httpMetadata?.contentEncoding === "gzip") {
    stream = stream.pipeThrough(new DecompressionStream("gzip"));
  }
  const text = await new Response(stream).text();
  const data = JSON.parse(text) as T;
  set({ fetched: Date.now(), data });
  return data;
}

const tokensOf = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);

const clipMatch = (c: ClipRecord, tokens: string[], creator: string): boolean => {
  if (creator && c.creator !== creator) return false;
  if (!tokens.length) return true;
  const hay = `${c.text || ""} ${c.title || ""} ${c.creator || ""}`.toLowerCase();
  return tokens.every((t) => hay.includes(t));
};

const segMatch = (s: VodSegment, tokens: string[], creator: string): boolean => {
  if (creator && s.c !== creator) return false;
  if (!tokens.length) return false;
  return tokens.every((t) => s.x.toLowerCase().includes(t));
};

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const creator = (url.searchParams.get("creator") || "").trim();
  const mode = (url.searchParams.get("mode") || "all").toLowerCase();
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") || 200)));
  const tokens = tokensOf(q);

  const [clipsIdx, vodsIdx, metaIdx] = await Promise.all([
    loadIndex<ClipIndex>(env.PUBLIC_BUCKET, "clips/index.json", _clipCache, (c) => { _clipCache = c; }),
    loadIndex<VodIndex>(env.PUBLIC_BUCKET, "transcripts/index.json", _vodCache, (c) => { _vodCache = c; }),
    loadIndex<VodMetaIndex>(env.PUBLIC_BUCKET, "vods/index.json", _metaCache, (c) => { _metaCache = c; })
      .catch(() => ({ vods: [] } as VodMetaIndex)), // tolerate missing index
  ]);

  // Build (creator, basename) -> twitch_vod_id lookup once per request.
  const tvById = new Map<string, VodMetaRow>();
  for (const r of metaIdx.vods || []) tvById.set(`${r.c}/${r.b}`, r);

  const clipHits = mode === "vod" ? [] :
    (clipsIdx.clips || []).filter((c) => clipMatch(c, tokens, creator)).map((rec) => ({ kind: "clip" as const, rec }));
  const segHits = mode === "clip" ? [] :
    (vodsIdx.segments || []).filter((s) => segMatch(s, tokens, creator)).map((s) => {
      const meta = tvById.get(`${s.c}/${s.b}`);
      const rec: VodSegment = meta ? { ...s, tv: meta.tv, title: meta.title } : s;
      return { kind: "vod" as const, rec };
    });

  const all = [...clipHits, ...segHits];
  return Response.json(
    {
      q, creator, mode, limit,
      n_clip_hits: clipHits.length,
      n_vod_hits: segHits.length,
      n_total: all.length,
      hits: all.slice(0, limit),
    },
    { headers: { "cache-control": "public, max-age=15" } },
  );
};
