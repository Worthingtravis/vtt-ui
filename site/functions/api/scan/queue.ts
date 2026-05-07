/**
 * POST /api/scan/queue
 *
 * Auth-gated proxy that queues a single VOD for the xcorr DBD-events
 * scanner on the local serve.py backend. Mirrors the auth pattern used
 * by /api/event_label/append so randos can't burn compute by spamming
 * scan kicks. Forwards X-VTT-User-Sub / X-VTT-User-Login so the job
 * record carries who requested it.
 *
 * Pre-flight: before queueing, hits /api/vod/availability to check
 * whether the audio file is available. If not:
 *   - has_stream_id: true  → 409 {ok:false, error:"vod_audio_missing",
 *                                  chainable:true, creator, basename}
 *   - has_stream_id: false → 410 {ok:false, error:"vod_audio_unrecoverable",
 *                                  creator, basename}
 * This surfaces a structured error to the UI before the xcorr_scan worker
 * would fail-fast with a FileNotFoundError after ~1s.
 *
 * Request:  {creator, basename}
 * Response: {ok, job_id, deduped?}    (200)
 *           {ok: false, error}        (400/401/409/410/502)
 */
import {
  AuthEnv,
  SESSION_COOKIE,
  readCookie,
  unpackSigned,
} from "../auth/_lib";

interface SessionPayload {
  sub: string;
  login: string | null;
  exp: number;
}

const PUBLIC_R2 = "https://pub-868d2bf7e2f6434c860d65dfe1cadad4.r2.dev";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function getRenderApi(): Promise<string | null> {
  try {
    const r = await fetch(`${PUBLIC_R2}/config.json`, { cf: { cacheTtl: 60 } } as RequestInit);
    if (!r.ok) return null;
    const d = (await r.json()) as { render_api_base?: string };
    return d.render_api_base || null;
  } catch {
    return null;
  }
}

interface QueuePayload {
  creator?: string;
  basename?: string;
}

interface AvailabilityResponse {
  ok: boolean;
  available?: boolean;
  has_stream_id?: boolean;
  has_meta?: boolean;
}

export const onRequestPost: PagesFunction<AuthEnv> = async ({ request, env }) => {
  if (!env.LW_COOKIE_SECRET) {
    return json({ ok: false, error: "auth not configured" }, 500);
  }
  const session = await unpackSigned<SessionPayload>(
    env.LW_COOKIE_SECRET,
    readCookie(request, SESSION_COOKIE),
  );
  if (!session || !session.sub) {
    return json({ ok: false, error: "log in to queue scans" }, 401);
  }

  let body: QueuePayload;
  try {
    body = (await request.json()) as QueuePayload;
  } catch {
    return json({ ok: false, error: "invalid json body" }, 400);
  }
  const creator = String(body.creator || "").trim();
  const basename = String(body.basename || "").trim().replace(/\.(mp4|mkv|webm|ts|json)$/i, "");
  if (!creator || !basename) {
    return json({ ok: false, error: "creator and basename required" }, 400);
  }
  // Defense-in-depth — serve.py also validates, but reject obviously
  // malformed values at the edge so we don't burn a tunnel hop.
  if (!/^[\w.-]+$/.test(creator)) {
    return json({ ok: false, error: "invalid creator" }, 400);
  }

  const renderApi = await getRenderApi();
  if (!renderApi) {
    return json({ ok: false, error: "render api unavailable" }, 502);
  }

  // Pre-flight: check VOD audio availability before queuing the scan.
  // This lets us surface a clean 409/410 to the UI instead of letting
  // the xcorr_scan worker fail-fast with a FileNotFoundError after ~1s.
  try {
    const avail = await fetch(
      `${renderApi}/api/vod/availability?creator=${encodeURIComponent(creator)}&basename=${encodeURIComponent(basename)}`,
      { method: "GET" },
    );
    if (avail.ok) {
      const ad = (await avail.json()) as AvailabilityResponse;
      if (ad.ok && ad.available === false) {
        if (ad.has_stream_id) {
          // VOD is missing but recoverable via vodvod — tell the UI to offer
          // the download+scan chain CTA.
          return json(
            { ok: false, error: "vod_audio_missing", chainable: true, creator, basename },
            409,
          );
        } else {
          // VOD was never indexed via vodvod (pre-R2 era) — unrecoverable.
          return json(
            { ok: false, error: "vod_audio_unrecoverable", creator, basename },
            410,
          );
        }
      }
      // available === true or availability check returned unexpected shape:
      // fall through and let the scan queue as normal.
    }
    // If the availability endpoint itself errored, fall through and let
    // xcorr_scan/job handle it — don't block scans over a transient backend
    // issue with the pre-flight.
  } catch {
    // Transient network error hitting availability — fall through.
  }

  const upstream = await fetch(`${renderApi}/api/xcorr_scan/job`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-vtt-user-sub": session.sub,
      "x-vtt-user-login": session.login || "",
    },
    body: JSON.stringify({ creator, basename }),
  });

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") || "application/json",
      "cache-control": "no-store",
    },
  });
};
