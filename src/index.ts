interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse$shared whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse$shared(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse$shared(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * Japan Procurement MCP — Japanese government tender notices (bid announcements) from national ministries, all 47 prefectures and municipalities, sourced from the Kankoju public procurement portal run by the Japan SME Agency.
 *
 * Sourced from the 官公需情報ポータルサイト (Kankōju Public Procurement Information
 * Portal) search API operated by the Japan Small and Medium Enterprise Agency
 * (中小企業庁) at kkj.go.jp/api/. The portal aggregates bid notices from national
 * ministries, the 47 prefectures, and municipalities — ~100k+ notices are
 * reachable for a common keyword. Keyless, documented at
 * https://www.kkj.go.jp/doc/ja/api_guide.pdf (V1.1).
 *
 * Auth: none.
 *
 * Two upstream traps this pack exists to absorb, both of which return a clean
 * success and therefore cannot be seen by a caller:
 *   1. LG_Code MUST be zero-padded to two digits. `LG_Code=1` returns
 *      SearchHits=0 — not an error, just an empty result that reads as
 *      "Hokkaido has no tenders". `LG_Code=01` returns 49,940.
 *   2. Category MUST be the numeric code (1/2/3). Passing the Japanese label
 *      (工事) returns `internal error: query error: syntax error`.
 * Both are normalised here, and an unmappable value is rejected with the
 * valid set named rather than forwarded.
 */


const BASE = 'https://www.kkj.go.jp/api/';
const UA = 'pipeworx-mcp-japan-procurement/1.0 (+https://pipeworx.io)';

// Bound every outbound call — the Workers runtime puts no timeout on a bare
// fetch(), so a degraded upstream would hold the Worker until its own
// execution budget kills the request.
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const headers = { 'User-Agent': UA, ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, 'Kankoju Procurement Portal (kkj.go.jp)');
}

// JIS X0401 prefecture codes. The upstream wants the two-digit string; callers
// say "Tokyo" or "東京都", so accept all three spellings.
const PREFECTURES: Array<{ code: string; ja: string; en: string }> = [
  { code: '01', ja: '北海道', en: 'Hokkaido' },
  { code: '02', ja: '青森県', en: 'Aomori' },
  { code: '03', ja: '岩手県', en: 'Iwate' },
  { code: '04', ja: '宮城県', en: 'Miyagi' },
  { code: '05', ja: '秋田県', en: 'Akita' },
  { code: '06', ja: '山形県', en: 'Yamagata' },
  { code: '07', ja: '福島県', en: 'Fukushima' },
  { code: '08', ja: '茨城県', en: 'Ibaraki' },
  { code: '09', ja: '栃木県', en: 'Tochigi' },
  { code: '10', ja: '群馬県', en: 'Gunma' },
  { code: '11', ja: '埼玉県', en: 'Saitama' },
  { code: '12', ja: '千葉県', en: 'Chiba' },
  { code: '13', ja: '東京都', en: 'Tokyo' },
  { code: '14', ja: '神奈川県', en: 'Kanagawa' },
  { code: '15', ja: '新潟県', en: 'Niigata' },
  { code: '16', ja: '富山県', en: 'Toyama' },
  { code: '17', ja: '石川県', en: 'Ishikawa' },
  { code: '18', ja: '福井県', en: 'Fukui' },
  { code: '19', ja: '山梨県', en: 'Yamanashi' },
  { code: '20', ja: '長野県', en: 'Nagano' },
  { code: '21', ja: '岐阜県', en: 'Gifu' },
  { code: '22', ja: '静岡県', en: 'Shizuoka' },
  { code: '23', ja: '愛知県', en: 'Aichi' },
  { code: '24', ja: '三重県', en: 'Mie' },
  { code: '25', ja: '滋賀県', en: 'Shiga' },
  { code: '26', ja: '京都府', en: 'Kyoto' },
  { code: '27', ja: '大阪府', en: 'Osaka' },
  { code: '28', ja: '兵庫県', en: 'Hyogo' },
  { code: '29', ja: '奈良県', en: 'Nara' },
  { code: '30', ja: '和歌山県', en: 'Wakayama' },
  { code: '31', ja: '鳥取県', en: 'Tottori' },
  { code: '32', ja: '島根県', en: 'Shimane' },
  { code: '33', ja: '岡山県', en: 'Okayama' },
  { code: '34', ja: '広島県', en: 'Hiroshima' },
  { code: '35', ja: '山口県', en: 'Yamaguchi' },
  { code: '36', ja: '徳島県', en: 'Tokushima' },
  { code: '37', ja: '香川県', en: 'Kagawa' },
  { code: '38', ja: '愛媛県', en: 'Ehime' },
  { code: '39', ja: '高知県', en: 'Kochi' },
  { code: '40', ja: '福岡県', en: 'Fukuoka' },
  { code: '41', ja: '佐賀県', en: 'Saga' },
  { code: '42', ja: '長崎県', en: 'Nagasaki' },
  { code: '43', ja: '熊本県', en: 'Kumamoto' },
  { code: '44', ja: '大分県', en: 'Oita' },
  { code: '45', ja: '宮崎県', en: 'Miyazaki' },
  { code: '46', ja: '鹿児島県', en: 'Kagoshima' },
  { code: '47', ja: '沖縄県', en: 'Okinawa' },
];

const CATEGORIES: Array<{ code: string; ja: string; en: string }> = [
  { code: '1', ja: '物品', en: 'goods' },
  { code: '2', ja: '工事', en: 'works' },
  { code: '3', ja: '役務', en: 'services' },
];

const PROCEDURE_TYPES: Array<{ code: string; ja: string; en: string }> = [
  { code: '1', ja: '一般競争入札', en: 'open competitive bidding' },
  { code: '2', ja: '簡易公募型競争入札', en: 'simplified public-invitation competitive bidding' },
  { code: '3', ja: '簡易公募型指名競争入札', en: 'simplified public-invitation selective bidding' },
];

const MAX_COUNT = 1000;          // upstream hard cap; larger values are clamped there anyway
const DEFAULT_COUNT = 20;
const DESC_PREVIEW_CHARS = 600;  // ProjectDescription carries the full notice text (often 100k+ chars)
const DESC_FULL_CHARS = 20_000;

const tools: McpToolExport['tools'] = [
  {
    name: 'japan_tenders_search',
    description:
      'Search Japanese government tender notices (bid announcements) by keyword across national ministries, all 47 prefectures and municipalities. Sourced from the 官公需情報ポータルサイト (Kankoju public procurement portal) run by the Japan SME Agency. Query accepts Japanese or ASCII text and the portal\'s operators: "A AND B", "A OR B", "A ANDNOT B", "NOT A", parentheses. Filter by category (goods/works/services), prefecture, procedure type and announcement date range. Returns buyer organisation, notice title, announcement date, bid/opening dates where published, the original notice URL and attachment links.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            'Keyword, Japanese or ASCII — e.g. "道路" (road), "システム" (system), "橋梁 AND 補修". Operators AND / OR / ANDNOT / NOT need surrounding spaces.',
        },
        category: {
          type: 'string',
          description: 'One of goods | works | services (or 物品 | 工事 | 役務, or 1 | 2 | 3).',
        },
        prefecture: {
          type: 'string',
          description:
            'Prefecture to restrict to — name ("Tokyo", "東京都") or JIS X0401 code ("13"). Comma-separate for several ("Tokyo,Osaka").',
        },
        procedure_type: {
          type: 'string',
          description:
            'Notice type: 1 = 一般競争入札 (open competitive bidding), 2 = 簡易公募型競争入札, 3 = 簡易公募型指名競争入札.',
        },
        organization_name: {
          type: 'string',
          description: 'Restrict to a buyer organisation, partial match — e.g. "国土交通省", "横浜市".',
        },
        project_name: { type: 'string', description: 'Restrict by notice title, partial match.' },
        issued_from: { type: 'string', description: 'Earliest announcement date (公告日), YYYY-MM-DD.' },
        issued_to: { type: 'string', description: 'Latest announcement date (公告日), YYYY-MM-DD.' },
        limit: {
          type: 'number',
          description: `Max notices to return, 1-${MAX_COUNT}. Default ${DEFAULT_COUNT}.`,
        },
        full_text: {
          type: 'boolean',
          description:
            'Return the full announcement text instead of a preview. The full text is often tens of thousands of characters; default false.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'japan_tenders_by_prefecture',
    description:
      'List Japanese government tender notices for one or more prefectures without needing a keyword — the way to browse what a given prefecture published recently. Sourced from the 官公需情報ポータルサイト (Kankoju public procurement portal, Japan SME Agency). Accepts a prefecture name ("Osaka", "大阪府") or JIS X0401 code ("27"), optionally narrowed by category, announcement date range and keyword.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        prefecture: {
          type: 'string',
          description:
            'Prefecture name ("Tokyo", "東京都") or JIS X0401 code ("13"). Comma-separate for several. Codes are zero-padded for you — a bare "1" returns nothing upstream.',
        },
        category: { type: 'string', description: 'One of goods | works | services (or 物品 | 工事 | 役務, or 1 | 2 | 3).' },
        query: { type: 'string', description: 'Optional keyword to narrow within the prefecture.' },
        issued_from: { type: 'string', description: 'Earliest announcement date (公告日), YYYY-MM-DD.' },
        issued_to: { type: 'string', description: 'Latest announcement date (公告日), YYYY-MM-DD.' },
        limit: { type: 'number', description: `Max notices to return, 1-${MAX_COUNT}. Default ${DEFAULT_COUNT}.` },
        full_text: { type: 'boolean', description: 'Return the full announcement text instead of a preview. Default false.' },
      },
      required: ['prefecture'],
    },
  },
  {
    name: 'japan_tenders_by_organization',
    description:
      'List Japanese government tender notices published by a named buyer — a ministry, agency, prefecture or city — matched on partial organisation name (e.g. "国土交通省", "防衛省", "横浜市"). Sourced from the 官公需情報ポータルサイト (Kankoju public procurement portal, Japan SME Agency). Optionally narrowed by category, keyword and announcement date range.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        organization_name: {
          type: 'string',
          description: 'Buyer organisation, partial match, in Japanese — e.g. "国土交通省" (MLIT), "経済産業省" (METI), "札幌市".',
        },
        category: { type: 'string', description: 'One of goods | works | services (or 物品 | 工事 | 役務, or 1 | 2 | 3).' },
        query: { type: 'string', description: 'Optional keyword to narrow within the organisation.' },
        issued_from: { type: 'string', description: 'Earliest announcement date (公告日), YYYY-MM-DD.' },
        issued_to: { type: 'string', description: 'Latest announcement date (公告日), YYYY-MM-DD.' },
        limit: { type: 'number', description: `Max notices to return, 1-${MAX_COUNT}. Default ${DEFAULT_COUNT}.` },
        full_text: { type: 'boolean', description: 'Return the full announcement text instead of a preview. Default false.' },
      },
      required: ['organization_name'],
    },
  },
  {
    name: 'japan_tender_reference',
    description:
      'Reference values accepted by the Japanese tender search tools: the three procurement categories, the notice/procedure types, and all 47 JIS X0401 prefecture codes with Japanese and romanised names. Call this when a filter value is rejected or when you need the code for a prefecture.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
];

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

function reqStr(args: Record<string, unknown>, key: string, example: string): string {
  const v = str(args, key);
  if (!v) throw new Error(`Required argument "${key}" is missing or empty. Pass a string like ${example}.`);
  return v;
}

function resolveCount(args: Record<string, unknown>): number {
  const raw = args.limit;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_COUNT;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`"limit" must be a positive number (1-${MAX_COUNT}). Got: ${JSON.stringify(raw)}`);
  }
  return Math.min(n, MAX_COUNT);
}

/** Category: the upstream 500s on a Japanese label, so map to the numeric code here. */
export function resolveCategory(input: string): string {
  const v = input.trim().toLowerCase();
  const hit = CATEGORIES.find((c) => c.code === v || c.ja === input.trim() || c.en === v);
  if (!hit) {
    throw new Error(
      `Unknown category ${JSON.stringify(input)}. Use one of: ` +
        CATEGORIES.map((c) => `${c.en} (${c.ja}, ${c.code})`).join(', ') + '.',
    );
  }
  return hit.code;
}

export function resolveProcedureType(input: string): string {
  const v = input.trim().toLowerCase();
  const hit = PROCEDURE_TYPES.find((p) => p.code === v || p.ja === input.trim() || p.en === v);
  if (!hit) {
    throw new Error(
      `Unknown procedure_type ${JSON.stringify(input)}. Use one of: ` +
        PROCEDURE_TYPES.map((p) => `${p.code} = ${p.ja} (${p.en})`).join('; ') + '.',
    );
  }
  return hit.code;
}

/**
 * Prefecture: accept a code, a Japanese name or a romanised name, and always
 * emit the zero-padded two-digit code. `LG_Code=1` is the silent-zero trap —
 * the upstream answers 200 with SearchHits=0 rather than rejecting it.
 */
export function resolvePrefectures(input: string): string[] {
  const parts = input.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) {
    throw new Error('"prefecture" is empty. Pass a name like "Tokyo" / "東京都" or a code like "13".');
  }
  return parts.map((part) => {
    const digits = part.match(/^\d{1,2}$/) ? part.padStart(2, '0') : null;
    const lower = part.toLowerCase().replace(/[-\s]/g, '');
    const hit = PREFECTURES.find(
      (p) =>
        p.code === digits ||
        p.ja === part ||
        p.en.toLowerCase() === lower ||
        `${p.en.toLowerCase()}prefecture` === lower ||
        p.en.toLowerCase() === lower.replace(/(ken|fu|to|prefecture)$/, ''),
    );
    if (!hit) {
      throw new Error(
        `Unknown prefecture ${JSON.stringify(part)}. Pass a JIS X0401 code 01-47, a Japanese name like "東京都", ` +
          'or a romanised name like "Tokyo". Call japan_tender_reference for the full list.',
      );
    }
    return hit.code;
  });
}

/** The upstream period format is "from/to", "from/", "/to" or a single date. */
export function buildPeriod(from?: string, to?: string): string | undefined {
  const check = (v: string, which: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      throw new Error(`"${which}" must be YYYY-MM-DD. Got: ${JSON.stringify(v)}`);
    }
    return v;
  };
  if (from && to) {
    const f = check(from, 'issued_from');
    const t = check(to, 'issued_to');
    return f === t ? f : `${f}/${t}`;
  }
  if (from) return `${check(from, 'issued_from')}/`;
  if (to) return `/${check(to, 'issued_to')}`;
  return undefined;
}

interface Filters {
  query?: string;
  category?: string;
  prefecture?: string;
  procedure_type?: string;
  organization_name?: string;
  project_name?: string;
  issued_from?: string;
  issued_to?: string;
}

function buildParams(f: Filters, count: number): URLSearchParams {
  const p = new URLSearchParams();
  if (f.query) p.set('Query', f.query);
  if (f.project_name) p.set('Project_Name', f.project_name);
  if (f.organization_name) p.set('Organization_Name', f.organization_name);
  if (f.prefecture) p.set('LG_Code', resolvePrefectures(f.prefecture).join(','));
  if (f.category) p.set('Category', resolveCategory(f.category));
  if (f.procedure_type) p.set('Procedure_Type', resolveProcedureType(f.procedure_type));
  const period = buildPeriod(f.issued_from, f.issued_to);
  if (period) p.set('CFT_Issue_Date', period);
  p.set('Count', String(count));
  return p;
}

interface Notice {
  key: string | null;
  title: string | null;
  organization: string | null;
  prefecture: string | null;
  prefecture_code: string | null;
  city: string | null;
  city_code: string | null;
  category: string | null;
  procedure_type: string | null;
  certification: string | null;
  location: string | null;
  item_code: string | null;
  announced: string | null;
  retrieved: string | null;
  tender_submission_deadline: string | null;
  opening_tenders_event: string | null;
  delivery_deadline: string | null;
  notice_url: string | null;
  file_type: string | null;
  file_size: number | null;
  description: string | null;
  description_truncated: boolean;
  attachments: Array<{ name: string | null; url: string | null }>;
}

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function pick(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  if (!m) return null;
  const v = decode(m[1]).trim();
  return v === '' ? null : v;
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function parseNotices(xml: string, fullText: boolean): Notice[] {
  const out: Notice[] = [];
  const re = /<SearchResult>([\s\S]*?)<\/SearchResult>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const body = m[1];
    const attachments: Notice['attachments'] = [];
    const attRe = /<Attachment>([\s\S]*?)<\/Attachment>/g;
    let a: RegExpExecArray | null;
    while ((a = attRe.exec(body)) !== null) {
      attachments.push({ name: pick(a[1], 'Name'), url: pick(a[1], 'Uri') });
    }
    const rawDesc = pick(body, 'ProjectDescription');
    const limit = fullText ? DESC_FULL_CHARS : DESC_PREVIEW_CHARS;
    const desc = rawDesc === null ? null : collapse(rawDesc);
    const size = pick(body, 'FileSize');
    out.push({
      key: pick(body, 'Key'),
      title: pick(body, 'ProjectName'),
      organization: pick(body, 'OrganizationName'),
      prefecture: pick(body, 'PrefectureName'),
      prefecture_code: pick(body, 'LgCode'),
      city: pick(body, 'CityName'),
      city_code: pick(body, 'CityCode'),
      category: pick(body, 'Category'),
      procedure_type: pick(body, 'ProcedureType'),
      certification: pick(body, 'Certification'),
      location: pick(body, 'Location'),
      item_code: pick(body, 'ItemCode'),
      announced: pick(body, 'CftIssueDate'),
      retrieved: pick(body, 'Date'),
      tender_submission_deadline: pick(body, 'TenderSubmissionDeadline'),
      opening_tenders_event: pick(body, 'OpeningTendersEvent'),
      delivery_deadline: pick(body, 'PeriodEndTime'),
      notice_url: pick(body, 'ExternalDocumentURI'),
      file_type: pick(body, 'FileType'),
      file_size: size !== null && /^\d+$/.test(size) ? Number(size) : null,
      description: desc === null ? null : desc.slice(0, limit),
      description_truncated: desc !== null && desc.length > limit,
      attachments,
    });
  }
  return out;
}

async function search(f: Filters, count: number, fullText: boolean) {
  const params = buildParams(f, count);
  const url = `${BASE}?${params.toString()}`;
  const res = await pwFetch(url);
  if (!res.ok) throw await httpError(res, 'Kankoju Procurement Portal (kkj.go.jp)');
  const xml = await res.text();

  const err = xml.match(/<Error>([\s\S]*?)<\/Error>/);
  if (err) {
    throw new Error(
      `Kankoju Procurement Portal rejected the search: ${collapse(decode(err[1]))}. ` +
        'Check the filter values — call japan_tender_reference for the accepted categories, procedure types and prefecture codes.',
    );
  }

  const hitsRaw = xml.match(/<SearchHits>(\d+)<\/SearchHits>/);
  const total = hitsRaw ? Number(hitsRaw[1]) : 0;
  const notices = parseNotices(xml, fullText);

  return {
    total_hits: total,
    returned: notices.length,
    // The upstream has no offset/page parameter and caps a single response at
    // 1,000 — narrow with issued_from/issued_to to walk a larger result set.
    more_available: total > notices.length,
    paging: total > notices.length
      ? 'The portal has no offset parameter and returns at most 1,000 notices per call. Narrow with issued_from / issued_to to reach the rest.'
      : null,
    filters: {
      query: f.query ?? null,
      category: f.category ? resolveCategory(f.category) : null,
      prefecture_codes: f.prefecture ? resolvePrefectures(f.prefecture) : null,
      procedure_type: f.procedure_type ? resolveProcedureType(f.procedure_type) : null,
      organization_name: f.organization_name ?? null,
      project_name: f.project_name ?? null,
      announced_between: buildPeriod(f.issued_from, f.issued_to) ?? null,
    },
    source: 'Kankoju Public Procurement Information Portal (官公需情報ポータルサイト), Japan Small and Medium Enterprise Agency — https://www.kkj.go.jp/',
    notices,
  };
}

function commonFilters(args: Record<string, unknown>): Filters {
  return {
    query: str(args, 'query'),
    category: str(args, 'category'),
    issued_from: str(args, 'issued_from'),
    issued_to: str(args, 'issued_to'),
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'japan_tenders_search':
      return search(
        {
          ...commonFilters(args),
          query: reqStr(args, 'query', '"道路" or "システム AND 保守"'),
          prefecture: str(args, 'prefecture'),
          procedure_type: str(args, 'procedure_type'),
          organization_name: str(args, 'organization_name'),
          project_name: str(args, 'project_name'),
        },
        resolveCount(args),
        args.full_text === true,
      );

    case 'japan_tenders_by_prefecture':
      return search(
        {
          ...commonFilters(args),
          prefecture: reqStr(args, 'prefecture', '"Tokyo", "東京都" or "13"'),
        },
        resolveCount(args),
        args.full_text === true,
      );

    case 'japan_tenders_by_organization':
      return search(
        {
          ...commonFilters(args),
          organization_name: reqStr(args, 'organization_name', '"国土交通省" or "横浜市"'),
        },
        resolveCount(args),
        args.full_text === true,
      );

    case 'japan_tender_reference':
      return {
        categories: CATEGORIES.map((c) => ({ code: c.code, japanese: c.ja, english: c.en })),
        procedure_types: PROCEDURE_TYPES.map((p) => ({ code: p.code, japanese: p.ja, english: p.en })),
        prefectures: PREFECTURES.map((p) => ({ code: p.code, japanese: p.ja, romanised: p.en })),
        notes: [
          'Prefecture codes are JIS X0401 and must be two digits — the tools zero-pad for you.',
          'Category and procedure_type must reach the portal as numeric codes; the tools map names and Japanese labels for you.',
          'Dates are 公告日 (announcement date), YYYY-MM-DD.',
          'A single call returns at most 1,000 notices and there is no offset parameter — narrow by date to page.',
        ],
        source: 'Kankoju Public Procurement Information Portal (官公需情報ポータルサイト), Japan Small and Medium Enterprise Agency — https://www.kkj.go.jp/',
      };

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
