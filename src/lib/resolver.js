// Full stream-resolution chain:
//   Stardima episode -> watch_url (hyperwatching embed)
//   -> hyperwatching data-page: video.hashid + servers[{id,name}]
//   -> GET hyperwatching /embed/{hashid}/server/{link_id}/url  => host embed url
//   -> fetch host embed, unpack Dean Edwards packer => m3u8 / mp4
// Returns a list of playable streams (one per working server).

const stardima = require('./stardima');
const { resolveHost, UA } = require('./hosts');

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

// Given a hyperwatching watch URL, return [{name, host embed url}] for each server.
async function getHyperwatchingServers(watchUrl) {
  let html;
  try {
    const res = await fetch(watchUrl, { headers: { 'User-Agent': UA, 'Referer': stardima.BASE + '/', 'Accept-Language': 'en-US,en;q=0.9' } });
    html = await res.text();
  } catch (e) { return []; }
  const props = extractInertiaProps(html);
  const video = props && props.props && props.props.video;
  if (!video || !video.hashid || !Array.isArray(video.servers)) return [];
  const hashid = video.hashid;
  const base = new URL(watchUrl).origin; // https://v2.hyperwatching.com
  const servers = [];
  for (const s of video.servers) {
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
  return servers;
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

  const servers = await getHyperwatchingServers(link.watch_url);
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
  const servers = await getHyperwatchingServers(link.watch_url);
  return { blocked: false, servers, title: link.title, series: link.series };
}


// ---- MOVIE servers: /play/<slug> embeds the hyperwatching iframe directly ----
async function getMovieServers(slug) {
  const html = await stardima.getHtml('/play/' + slug, stardima.BASE + '/movie/' + slug);
  const m = html.match(/https?:\/\/v\d+\.hyperwatching\.com\/watch\/[A-Za-z0-9_-]+/i)
    || html.match(/<iframe[^>]+src="(https?:\/\/[^"]+\/watch\/[A-Za-z0-9_-]+)"/i);
  const watchUrl = m ? (m[1] || m[0]) : null;
  if (!watchUrl) return { blocked: false, servers: [], watch_url: null };
  const servers = await getHyperwatchingServers(watchUrl);
  return { blocked: false, servers, watch_url: watchUrl };
}

// Known-good host order: workers can reach uqload/mixdrop reliably, while
// goodstream/savefiles/streamhg 404 and lulustream 403s from edge IPs.
const HOST_PRIORITY = [
  [/uqload/i, 0], [/mixdrop/i, 1], [/vidlo|videobin|vidbom|doodstream|streamsb|upstream/i, 2],
  [/lulustream/i, 3], [/strema|goodstream/i, 4], [/savefiles/i, 5], [/hgcloud|streamhg/i, 6],
];
function hostRank(srv) {
  const s = (srv && ((srv.name || '') + ' ' + (srv.embedUrl || ''))) || '';
  for (const [re, r] of HOST_PRIORITY) if (re.test(s)) return r;
  return 7;
}
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('probe timeout')), ms)),
  ]);
}
// Order servers so a WORKING one is first: rank by host, then health-probe the
// top few in parallel (resolution is cheap; the player only fetches the winner).
async function orderServers(servers, opts = {}) {
  const list = (servers || []).slice();
  const ranked = list.map((s) => ({ s, rank: hostRank(s) })).sort((a, b) => a.rank - b.rank || 0);
  if (opts.probe === false) return ranked.map((x) => x.s);
  const maxProbe = opts.maxProbe || 5;
  const head = ranked.slice(0, maxProbe);
  const rest = ranked.slice(maxProbe).map((x) => x.s);
  const probed = await Promise.all(head.map(async ({ s }) => {
    try {
      const r = await withTimeout(resolveHost(s.embedUrl), opts.probeMs || 9000);
      return { s, ok: !!(r && r.url) };
    } catch (e) { return { s, ok: false }; }
  }));
  return [
    ...probed.filter((x) => x.ok).map((x) => x.s),
    ...probed.filter((x) => !x.ok).map((x) => x.s),
    ...rest,
  ];
}

module.exports = { resolveEpisode, getServers, getMovieServers, orderServers, hostRank, getHyperwatchingServers, extractInertiaProps };
