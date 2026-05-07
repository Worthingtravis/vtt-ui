/** /api/creators — sorted creator list + counts for the filter dropdown.
 *
 * Reads ``creators/index.json`` (~1 KB) instead of parsing the 28 MB
 * ``transcripts/index.json`` on every cold isolate. The transcripts read
 * was the cause of intermittent 503s ("creator list unavailable") when the
 * isolate timed out / blew its memory budget.
 */
interface Env { PUBLIC_BUCKET: R2Bucket }
interface CreatorRow { name: string; n_clips: number; n_vods: number; n_segments: number }
interface CreatorsIndex {
  schema_version?: number;
  generated_at?: string;
  n_clips?: number;
  n_vods?: number;
  n_segments?: number;
  creators?: CreatorRow[];
}

let _cache: { fetched: number; data: CreatorsIndex } | null = null;
const TTL = 60_000;

async function readJson(bucket: R2Bucket, key: string) {
  const obj = await bucket.get(key);
  if (!obj) return null;
  let s: ReadableStream<Uint8Array> = obj.body;
  if (obj.httpMetadata?.contentEncoding === "gzip") s = s.pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(s).text());
}

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  let idx: CreatorsIndex | null = null;
  if (_cache && (Date.now() - _cache.fetched) < TTL) {
    idx = _cache.data;
  } else {
    idx = await readJson(env.PUBLIC_BUCKET, "creators/index.json");
    if (idx) _cache = { fetched: Date.now(), data: idx };
  }
  if (!idx) {
    // Fallback: derive a minimal list from the clip + transcript indexes the
    // way the old code did. Pricier (downloads transcripts/index.json) but
    // ensures the UI still works if creators/index.json hasn't been built.
    const [clips, vods] = await Promise.all([
      readJson(env.PUBLIC_BUCKET, "clips/index.json"),
      readJson(env.PUBLIC_BUCKET, "transcripts/index.json"),
    ]);
    const set = new Set<string>();
    ((clips?.clips || []) as { creator: string }[]).forEach((c) => set.add(c.creator));
    ((vods?.segments || []) as { c: string }[]).forEach((s) => set.add(s.c));
    return Response.json(
      {
        creators: [...set].sort(),
        n_clips: clips?.n_clips ?? clips?.clips?.length ?? 0,
        n_vods: vods?.n_vods ?? 0,
        n_segments: vods?.n_segments ?? vods?.segments?.length ?? 0,
        fallback: true,
      },
      { headers: { "cache-control": "public, max-age=60" } },
    );
  }
  const rows = idx.creators || [];
  return Response.json(
    {
      creators: rows.map((r) => r.name).sort(),
      creator_stats: rows,
      n_clips: idx.n_clips ?? 0,
      n_vods: idx.n_vods ?? 0,
      n_segments: idx.n_segments ?? 0,
    },
    { headers: { "cache-control": "public, max-age=60" } },
  );
};
