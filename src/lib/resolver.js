// Full stream-resolution chain:
//   Stardima episode -> watch_url (hyperwatching embed)
//   -> hyperwatching data-page: video.hashid + servers[{id,name}]
//   -> GET hyperwatching /embed/{hashid}/server/{link_id}/url  => host embed url
//   -> fetch host embed, unpack Dean Edwards packer => m3u8 / mp4
// Returns a list of playable streams (one per working server).

const stardima = require('./stardima');
const { resolveHost, unwrapEmbed, UA } = require('./hosts');

function decodeEntities(s) {
  return (s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/\\\//g, '/').trim();
}

// Parse the Inertia data-page JSON out of an HTML page.
function extractInertiaProps(html) {
  const m = html.match(/data-page="([^"]*)"/) || html.match(/data-page='([^']*)'/);
  if (!m) return null;
  try {
    const decoded = m[1]
      .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#039;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    return JSON.parse(decoded);
  } catch (e) {
    return null;
  }
}

// Given a hyperwatching watch URL, return { servers: [{name, host embed url}], pending }.
// A server the source is still "processing" has no link at all — every id 404s — so it
// is reported as pending instead of costing a request that can only fail.
async function getHyperwatchingServers(watchUrl) {
  let html;
  try {
    const res = await fetch(watchUrl, { headers: { 'User-Agent': UA, 'Referer': stardima.BASE + '/', 'Accept-Language': 'en-US,en;q=0.9' } });
    html = await res.text();
  } catch (e) { return { servers: [], pending: 0 }; }
  const props = extractInertiaProps(html);
  const video = props && props.props && props.props.video;
  if (!video || !video.hashid || !Array.isArray(video.servers)) return { servers: [], pending: 0 };
  const hashid = video.hashid;
  const base = new URL(watchUrl).origin; // https://v2.hyperwatching.com
  const servers = [];
  let pending = 0;
  for (const s of video.servers) {
    if (s.status && s.status !== 'completed') { pending++; continue; }
    // Resolve the actual host embed url for this server
    try {
      const res = await fetch(`${base}/embed/${hashid}/server/${s.id}/url`, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'Referer': watchUrl },
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data && data.watch_url) servers.push({ name: s.name || ('server ' + s.server_id), embedUrl: decodeEntities(data.watch_url), is_vip: !!s.is_vip });
    } catch (e) { /* skip this server */ }
  }
  return { servers, pending };
}

// Resolve all playable streams for a Stardima episode id (eager: resolves m3u8 now).
// Kept for testing/direct use. The server uses getServers() + lazy proxy instead,
// because the upstream m3u8 token must be fetched fresh at playback time.
async function resolveEpisode(episodeId) {
  const link = await stardima.getEpisodeLink(episodeId);
  if (!link.can_watch) {
    return { blocked: true, reason: link.reason, streams: [] };
  }
  if (!link.watch_url) return { blocked: false, streams: [] };

  const { servers } = await getHyperwatchingServers(link.watch_url);
  const streams = [];
  for (const srv of servers) {
    try {
      const r = await resolveHost(srv.embedUrl);
      if (r && r.url) {
        streams.push({ name: srv.name, url: r.url, type: r.type, referer: r.referer });
      }
    } catch (e) { /* keep trying other servers */ }
  }
  return { blocked: false, streams, title: link.title, series: link.series };
}

// Lazy variant: return the server list (name + host embed url) WITHOUT resolving
// the m3u8. The addon hands each embed url to the proxy, which resolves the
// stream fresh at playback time (the upstream token is short-lived).
async function getServers(episodeId) {
  const link = await stardima.getEpisodeLink(episodeId);
  if (!link.can_watch) return { blocked: true, reason: link.reason, servers: [] };
  if (!link.watch_url) return { blocked: false, servers: [] };
  const { servers, pending } = await getHyperwatchingServers(link.watch_url);
  return { blocked: false, servers, pending, watch_url: link.watch_url, title: link.title, series: link.series };
}


// ---- MOVIE servers: /play/<slug> embeds the hyperwatching iframe directly ----
async function getMovieServers(slug) {
  const html = await stardima.getHtml('/play/' + slug, stardima.BASE + '/movie/' + slug);
  const m = html.match(/https?:\/\/v\d+\.hyperwatching\.com\/watch\/[A-Za-z0-9_-]+/i)
    || html.match(/<iframe[^>]+src="(https?:\/\/[^"]+\/watch\/[A-Za-z0-9_-]+)"/i);
  const watchUrl = m ? (m[1] || m[0]) : null;
  if (!watchUrl) return { blocked: false, servers: [], watch_url: null };
  const { servers, pending } = await getHyperwatchingServers(watchUrl);
  return { blocked: false, servers, pending, watch_url: watchUrl };
}

// Host order, measured on Deno Deploy after the move off Cloudflare (2026-10-12).
// Uqload is first: it answers 12/12 once the strema.top wrapper is unwrapped, and it
// is the host our per-work quality figures were measured on, so the badge is honest.
// Mixdrop is a close second (direct mp4). The rest have never answered for us.
const HOST_PRIORITY = [
  [/uqload|strema\.top/i, 0], [/mixdrop/i, 1], [/vidlo|videobin|vidbom|doodstream|streamsb|upstream/i, 2],
  [/lulustream|luluvdo/i, 3], [/savefiles/i, 4], [/hgcloud|streamhg/i, 5], [/goodstream/i, 6],
];
function hostRank(srv) {
  const s = (srv && ((srv.name || '') + ' ' + (srv.embedUrl || ''))) || '';
  for (const [re, r] of HOST_PRIORITY) if (re.test(s)) return r;
  return 7;
}
// Host health memory. A static priority puts the habitual winner (uqload) first
// with zero latency; background probes then demote hosts that start failing, so
// the *next* request is already correct.
const _health = new Map(); // hostname -> { ok: boolean, t: number }
const HEALTH_OK_TTL = 30 * 60 * 1000;
const HEALTH_FAIL_TTL = 2 * 60 * 1000; // short: these hosts come and go by the minute

function hostKeyOf(srv) {
  // health belongs to the host that serves the file, not to the wrapper around it
  try { return new URL(unwrapEmbed(srv.embedUrl)).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}
function healthPenalty(srv) {
  const h = _health.get(hostKeyOf(srv));
  if (!h) return 0;
  if (Date.now() - h.t > (h.ok ? HEALTH_OK_TTL : HEALTH_FAIL_TTL)) return 0;
  return h.ok ? -0.5 : 20; // known-good floats up, known-dead sinks (no exceptions)
}
// A host counts as healthy only when the whole chain answers: embed -> resolved
// file -> the first bytes. Resolving alone is not enough — several hosts hand out
// a link and then refuse it (403) the moment the player actually opens it.
async function fetchWith(url, opts, ms) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(to); }
}
async function verifyServer(srv, ms = 9000) {
  // Hosts refuse in bursts: Mixdrop answers seven requests out of ten, so one unlucky
  // probe must not hide a working server for the next two minutes. Try twice.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 600));
    let r = null;
    try { r = await resolveHost(srv.embedUrl); } catch (e) { r = null; }
    if (!r || !r.url) continue;
    try {
      const res = await fetchWith(r.url, { headers: { 'User-Agent': UA, Referer: r.referer, Accept: '*/*', Range: 'bytes=0-1000' } }, ms);
      if (res && (res.ok || res.status === 206)) return r;
    } catch (e) { /* try once more */ }
  }
  return false;
}
function probeServers(servers, slots) {
  const jobs = [];
  for (const srv of servers.slice(0, slots || 3)) {
    const key = hostKeyOf(srv);
    if (!key || !/^https?:/i.test(srv.embedUrl || '')) continue;
    jobs.push(
      verifyServer(srv)
        .then((resolved) => {
          if (resolved && resolved.url) srv.resolved = resolved;
          _health.set(key, { ok: !!resolved, t: Date.now(), resolved: resolved || null });
        })
        .catch(() => { _health.set(key, { ok: false, t: Date.now(), resolved: null }); })
    );
  }
  return jobs;
}
async function orderServers(servers, opts = {}) {
  const list = (servers || []).slice();
  if (opts.probe === false) return list.sort((a, b) => hostRank(a) - hostRank(b));
  const ranked = list
    .map((s, i) => ({ s, i, rank: hostRank(s) + healthPenalty(s) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i);
  const out = ranked.map((x) => x.s);
  const jobs = probeServers(out, opts.maxProbe || 4);
  if (opts.verifyBudget) {
    // wait a moment for the probes, then put the ones that answered first — this is what
    // stops the player from opening a dead host and making you tap three servers
    try {
      await Promise.race([
        Promise.all(jobs),
        new Promise((r) => setTimeout(r, opts.verifyBudget)),
      ]);
      const rank = (srv) => {
        const h = _health.get(hostKeyOf(srv));
        if (!h) return 1;               // unknown → middle
        return h.ok ? 0 : 2;            // verified → first, known-failed → last
      };
      return out
        .map((s, i) => ({ s, i, r: rank(s) }))
        .sort((a, b) => a.r - b.r || a.i - b.i)
        .map((x) => x.s);
    } catch (e) { /* fall through to the instant order */ }
  }
  if (opts.waitUntil) { try { opts.waitUntil(Promise.all(jobs)); } catch (e) { /* no ctx */ } }
  return out;
}

function serverHealth(srv) {
  const h = _health.get(hostKeyOf(srv));
  if (!h) return 'unknown';
  if (!h.ok) return 'bad';
  return 'ok';
}
function serverResolved(srv) {
  if (srv && srv.resolved && srv.resolved.url) return srv.resolved;
  const h = _health.get(hostKeyOf(srv));
  return h && h.ok && h.resolved && h.resolved.url ? h.resolved : null;
}

module.exports = { resolveEpisode, getServers, getMovieServers, orderServers, hostRank, getHyperwatchingServers, extractInertiaProps, serverHealth, serverResolved };
