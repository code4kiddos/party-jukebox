// jukebox.js — a party jukebox for your Spotify. Node 18+, no dependencies.
//
// Guests search for songs on a web page, add them to a shared list, and vote songs up.
// Only you (the host) ever log in to Spotify; guests just use the page.
//
// How voting works: Spotify doesn't let apps reorder its queue, so the jukebox keeps its
// own list, sorted by votes. About 20 seconds before the current song ends, it hands the
// top-voted song to Spotify's queue. That song is then locked in as "Playing next".
// Between requests, whatever you started on Spotify (e.g. a playlist) keeps playing.
//
// Required settings (environment variables):
//   SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET   from developer.spotify.com/dashboard
//   ADMIN_KEY                                  a password you pick (letters and numbers only)
// Until they're set, the home page shows what's missing and the Redirect URI to give Spotify.
//
// On your own computer:
//   SPOTIFY_CLIENT_ID=xxx SPOTIFY_CLIENT_SECRET=yyy ADMIN_KEY=pick-a-secret node jukebox.js
//   then open http://127.0.0.1:8888/login?key=pick-a-secret
// On Render: set the three variables in the Environment tab, then open
//   https://<your-app>.onrender.com/login?key=pick-a-secret
//
// Optional settings (environment variables):
//   PORT=8888                 port to listen on (Render sets this for you)
//   REDIRECT_URI=...          must match the Redirect URI in your Spotify dashboard exactly.
//                             Defaults to <Render URL>/callback on Render, else 127.0.0.1.
//   COOLDOWN_SECONDS=30       how long each guest waits between adding songs (votes are unlimited)
//   LEAD_SECONDS=20           how long before a song ends to hand the next one to Spotify
//   ALLOW_EXPLICIT=false      hide and block songs Spotify marks as Explicit (the "E" label)
//   WORD_FILTER=off           turn off the rude-word filter (it's on by default)
//   EXTRA_BLOCKED_WORDS=a,b   more words to block, comma-separated (whole words)
//   SPOTIFY_REFRESH_TOKEN=... lets the jukebox log itself back in after a restart on hosts
//                             that wipe files (e.g. Render's free tier). The /callback page
//                             shows you this value after you log in.
//
// The song list and votes live in memory, so they reset if the server restarts.

const http = require('node:http');
const fs = require('node:fs');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 8888);
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI
  || (process.env.RENDER_EXTERNAL_URL ? process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '') + '/callback' : '')
  || `http://127.0.0.1:${PORT}/callback`;
const ADMIN_KEY = process.env.ADMIN_KEY;
const COOLDOWN_MS = Number(process.env.COOLDOWN_SECONDS || 30) * 1000;
const LEAD_MS = Number(process.env.LEAD_SECONDS || 20) * 1000;
const ALLOW_EXPLICIT = process.env.ALLOW_EXPLICIT !== 'false';
const WORD_FILTER = process.env.WORD_FILTER !== 'off';
const DUPLICATE_WINDOW_MS = 60 * 60 * 1000; // a song can't be requested again within 1 hour of playing
const MAX_WAITING = 100;                    // most songs the list will hold at once
const TOKEN_FILE = 'tokens.json';
const SCOPES = 'user-modify-playback-state user-read-playback-state user-read-currently-playing';

// Don't crash when settings are missing: stay up and show a setup page instead,
// so a first deploy succeeds and tells you what to do next.
const MISSING = [
  !CLIENT_ID && 'SPOTIFY_CLIENT_ID',
  !CLIENT_SECRET && 'SPOTIFY_CLIENT_SECRET',
  !ADMIN_KEY && 'ADMIN_KEY',
].filter(Boolean);
if (MISSING.length) console.warn('Setup not finished. Missing settings: ' + MISSING.join(', '));

// ---------- Host's Spotify tokens (saved to disk so restarts don't need a re-login) ----------

let tokens = null; // { access_token, refresh_token, expires_at, authorized_at }
try { tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch {}
if (!tokens && process.env.SPOTIFY_REFRESH_TOKEN) {
  // No saved file (fresh cloud container): start from the refresh token in the environment.
  tokens = { access_token: '', refresh_token: process.env.SPOTIFY_REFRESH_TOKEN, expires_at: 0 };
}
function saveTokens() {
  try { fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens), { mode: 0o600 }); }
  catch (e) { console.warn('Could not save tokens.json (read-only disk?):', e.message); }
}
function clearTokens() { tokens = null; try { fs.unlinkSync(TOKEN_FILE); } catch {} }

const basicAuth = 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

function httpError(status, message, reason) {
  return Object.assign(new Error(message), { status, reason });
}

async function tokenRequest(params) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: basicAuth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(502, data.error_description || data.error || 'Token request failed', data.error);
  return data;
}

let refreshing = null; // shared promise so simultaneous requests trigger only one refresh
async function getAccessToken() {
  if (!tokens) throw httpError(503, "The host hasn't connected Spotify yet.");
  if (Date.now() < tokens.expires_at - 60_000) return tokens.access_token;
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const d = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
        tokens.access_token = d.access_token;
        tokens.expires_at = Date.now() + d.expires_in * 1000;
        if (d.refresh_token) tokens.refresh_token = d.refresh_token;
        saveTokens();
        return tokens.access_token;
      } catch (e) {
        // Spotify refresh tokens now expire 6 months after login: don't retry, just log in again.
        if (e.reason === 'invalid_grant') {
          clearTokens();
          throw httpError(503, 'Spotify login expired. Host: open /login again.');
        }
        throw e;
      } finally {
        refreshing = null;
      }
    })();
  }
  return refreshing;
}

async function spotify(method, path) {
  const token = await getAccessToken();
  const res = await fetch('https://api.spotify.com/v1' + path, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    throw httpError(res.status, data?.error?.message || `Spotify error ${res.status}`, data?.error?.reason);
  }
  return data;
}

function simplify(t) {
  return {
    uri: t.uri,
    name: t.name,
    artists: (t.artists || []).map(a => a.name).join(', ') || t.show?.name || '',
    image: (t.album?.images || t.images || []).at(-1)?.url || '', // smallest image is last
    explicit: !!t.explicit,
  };
}

// ---------- Rude-word filter ----------
// Blocks rude searches, and hides songs whose title, artist or album contains a rude word.
// It's a simple word list, so it won't catch everything; Spotify's own Explicit label
// (ALLOW_EXPLICIT=false) is the stronger filter. Use both for a clean party.

// Blocked even inside longer words ("bullshit", "motherfucker").
const BLOCKED_INSIDE = ['fuck', 'shit'];
// Blocked when a word starts with them ("bitches", "sluts").
const BLOCKED_STARTS = ['bitch', 'cunt', 'nigg', 'fagg', 'whore', 'slut', 'twat', 'wank', 'dildo', 'pornh'];
// Blocked only as whole words, so "class", "assassin" and "cocktail" still work.
const BLOCKED_WHOLE = new Set([
  'ass', 'asses', 'asshole', 'assholes', 'arse', 'arsehole', 'dick', 'dicks', 'cock', 'cocks',
  'pussy', 'pussies', 'porn', 'porno', 'fag', 'fags', 'tits', 'titties', 'boobs', 'cum', 'hoes',
  'bollocks', 'milf', 'nsfw', 'xxx', 'wtf', 'stfu', 'mf',
  // Common Singapore/Malaysia ones
  'knn', 'ccb', 'chibai', 'cheebye', 'lanjiao', 'kanina', 'pukimak', 'puki',
  ...(process.env.EXTRA_BLOCKED_WORDS || '').split(',').map(w => w.trim().toLowerCase()).filter(Boolean),
]);

function words(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD').replace(/\p{M}/gu, '')                     // "fück" -> "fuck"
    .replace(/[@4]/g, 'a').replace(/3/g, 'e').replace(/[1!|]/g, 'i')
    .replace(/0/g, 'o').replace(/[$5]/g, 's').replace(/7/g, 't')  // "sh1t", "$hit"
    .split(/[^a-z]+/)
    .filter(Boolean);
}

function isRude(text) {
  if (!WORD_FILTER) return false;
  return words(text).some(w =>
    BLOCKED_WHOLE.has(w)
    || BLOCKED_STARTS.some(b => w.startsWith(b))
    || BLOCKED_INSIDE.some(b => w.includes(b)));
}

function isRudeTrack(t) {
  return isRude(t.name) || isRude(t.album?.name) || (t.artists || []).some(a => isRude(a.name));
}

const PARTY_FRIENDLY = "Let's keep it party-friendly 🙂 Try another song.";

// ---------- Search ----------

async function searchTracks(q) {
  if (isRude(q)) throw httpError(400, PARTY_FRIENDLY);
  // Development-mode apps can get at most 10 results per search request.
  // No `market` parameter: with the host's token, Spotify already uses the host's country,
  // and `market=from_token` now fails with "Insufficient client scope".
  const params = new URLSearchParams({ q, type: 'track', limit: '10' });
  const data = await spotify('GET', '/search?' + params);
  return (data?.tracks?.items || [])
    .filter(Boolean)
    .filter(t => ALLOW_EXPLICIT || !t.explicit)
    .filter(t => !isRudeTrack(t))
    .map(simplify);
}

// ---------- What's playing (shared, cached so many guests don't hit Spotify's rate limit) ----------

let playback = null;     // last answer from Spotify's "playback state"
let playbackAt = 0;
let playbackPromise = null;

async function getPlayback() {
  if (playback && Date.now() - playbackAt < 4000) return playback;
  if (!playbackPromise) {
    playbackPromise = spotify('GET', '/me/player')
      .then(d => { playback = d || {}; playbackAt = Date.now(); return playback; }) // empty = no active device
      .finally(() => { playbackPromise = null; });
  }
  return playbackPromise;
}

// ---------- The request list and voting ----------

const waiting = [];              // songs guests added, not yet handed to Spotify
let playingNext = null;          // the song we've handed to Spotify's queue that hasn't started yet
const recentlyPlayed = new Map(); // uri -> when we handed it to Spotify
const lastAddByGuest = new Map(); // guest -> when they last added a song
let feedProblem = '';            // last problem handing a song to Spotify, shown to guests

function ranked() {
  // Most votes first; ties go to whoever asked first.
  return [...waiting].sort((a, b) => b.votes.size - a.votes.size || a.addedAt - b.addedAt);
}

async function addSong(guest, uri) {
  if (!/^spotify:track:[A-Za-z0-9]{22}$/.test(uri)) throw httpError(400, "That doesn't look like a Spotify track.");

  // Already on the list? Count it as a vote instead.
  const existing = waiting.find(s => s.uri === uri);
  if (existing) {
    existing.votes.add(guest);
    return { upvoted: true };
  }
  if (playingNext?.uri === uri) throw httpError(409, "That one's already playing next! 🎶");
  if (playback?.item?.uri === uri) throw httpError(409, "That one's playing right now! 🎶");
  const played = recentlyPlayed.get(uri);
  if (played && Date.now() - played < DUPLICATE_WINDOW_MS) throw httpError(409, 'That one played recently. Pick another!');

  const wait = (lastAddByGuest.get(guest) || 0) + COOLDOWN_MS - Date.now();
  if (wait > 0) {
    throw httpError(429, `Easy there! You can add another song in ${Math.ceil(wait / 1000)}s. Voting is unlimited 👍`);
  }
  if (waiting.length >= MAX_WAITING) throw httpError(429, 'The list is full right now. Vote for a song instead!');

  // Look the song up ourselves (don't trust the browser), and re-check the filters.
  const track = await spotify('GET', '/tracks/' + uri.split(':')[2]);
  if (!track?.uri) throw httpError(404, "Couldn't find that song.");
  if (!ALLOW_EXPLICIT && track.explicit) throw httpError(403, 'Explicit songs are turned off tonight.');
  if (isRudeTrack(track)) throw httpError(403, PARTY_FRIENDLY);

  waiting.push({ ...simplify(track), addedAt: Date.now(), addedBy: guest, votes: new Set([guest]) });
  lastAddByGuest.set(guest, Date.now());
  feed(); // hands it to Spotify straight away if the current song is nearly over
  return { added: true };
}

function toggleVote(guest, uri) {
  const song = waiting.find(s => s.uri === uri);
  if (!song) throw httpError(404, "Too late, that one's already lined up or played!");
  if (song.votes.has(guest)) song.votes.delete(guest);
  else song.votes.add(guest);
  return { votes: song.votes.size, voted: song.votes.has(guest) };
}

// Every few seconds: when the current song is nearly over, hand the top-voted song to Spotify.
let feeding = false;
async function feed() {
  if (feeding || !tokens || MISSING.length || (!waiting.length && !playingNext)) return;
  feeding = true;
  try {
    const p = await getPlayback();
    const current = p.item;

    // The song we lined up has started, so it's no longer "next".
    if (playingNext && current?.uri === playingNext.uri) playingNext = null;

    // Safety net: if our lined-up song vanished (queue cleared, device switched), stop waiting for it.
    if (playingNext && Date.now() - playingNext.sentAt > 20 * 60_000) {
      const q = await spotify('GET', '/me/player/queue');
      if (q?.queue?.some(t => t?.uri === playingNext.uri)) playingNext.sentAt = Date.now();
      else playingNext = null;
    }

    if (playingNext || !waiting.length) return;
    if (!p.device) { feedProblem = "Spotify isn't playing on any device. Host: press play somewhere first."; return; }

    const sinceChecked = p.is_playing ? Date.now() - playbackAt : 0;
    const remaining = current ? current.duration_ms - (p.progress_ms || 0) - sinceChecked : 0;
    if (p.is_playing && remaining > LEAD_MS) { feedProblem = ''; return; } // still collecting votes

    const top = ranked()[0];
    await spotify('POST', '/me/player/queue?uri=' + encodeURIComponent(top.uri));
    waiting.splice(waiting.indexOf(top), 1);
    playingNext = { ...top, sentAt: Date.now() };
    recentlyPlayed.set(top.uri, Date.now());
    feedProblem = '';

    for (const [uri, at] of recentlyPlayed) if (Date.now() - at > DUPLICATE_WINDOW_MS) recentlyPlayed.delete(uri);
  } catch (e) {
    feedProblem = friendlyError(e);
  } finally {
    feeding = false;
  }
}
setInterval(feed, 5000);

function publicSong(s) {
  return { uri: s.uri, name: s.name, artists: s.artists, image: s.image, explicit: s.explicit };
}

async function nowState(guest) {
  let current = null;
  let problem = '';
  try {
    const p = await getPlayback();
    current = p.item ? simplify(p.item) : null;
    if (!p.device) problem = "Spotify isn't playing on any device. Host: press play somewhere first.";
  } catch (e) {
    problem = friendlyError(e);
  }
  return {
    current,
    problem: problem || feedProblem,
    next: playingNext ? publicSong(playingNext) : null,
    waiting: ranked().map(s => ({
      ...publicSong(s),
      votes: s.votes.size,
      voted: s.votes.has(guest),
      mine: s.addedBy === guest,
    })),
  };
}

function friendlyError(e) {
  if (e.reason === 'NO_ACTIVE_DEVICE' || (e.status === 404 && /device/i.test(e.message))) {
    return "Spotify isn't playing on any device. Host: press play somewhere first.";
  }
  if (e.reason === 'PREMIUM_REQUIRED') return 'The host account needs Spotify Premium.';
  if (e.reason === 'QUOTA_EXCEEDED') return 'Spotify is rate-limiting the jukebox. Try again in a minute.';
  if (e.status === 403 && /not registered|not approved/i.test(e.message)) {
    return "Spotify doesn't recognise the host's account for this app. Host: add it under User Management in your Spotify developer app settings.";
  }
  return e.message || 'Something went wrong.';
}

// ---------- Guests: each browser gets a random ID in a cookie ----------
// (Using IP addresses doesn't work: everyone on the party Wi-Fi shares one.)

function guestFor(req, res) {
  const match = /(?:^|;\s*)jb_guest=([a-f0-9]{24})/.exec(req.headers.cookie || '');
  if (match) return match[1];
  const id = crypto.randomBytes(12).toString('hex');
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `jb_guest=${id}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly${secure}`);
  return id;
}

// ---------- Simple pages for the host (setup, login result) ----------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function infoPage(title, bodyHtml) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font: 16px/1.5 system-ui, -apple-system, sans-serif; background: #121212; color: #fff; }
  main { max-width: 560px; margin: 0 auto; padding: 16px; }
  h1 { font-size: 1.4rem; }
  code, textarea { font: 14px ui-monospace, monospace; background: #2a2a2a; color: #fff; border-radius: 6px; }
  code { padding: 2px 6px; word-break: break-all; }
  textarea { width: 100%; box-sizing: border-box; padding: 10px; border: 0; height: 7em; }
  button { padding: 10px 16px; border-radius: 999px; border: 0; background: #1ed760; color: #000; font-weight: 700; font-size: 15px; }
  li { margin: 6px 0; }
</style></head>
<body><main><h1>${escapeHtml(title)}</h1>${bodyHtml}</main></body></html>`;
}

function setupPage() {
  return infoPage('Almost there! 🎵', `
    <p>The jukebox is running, but it still needs these settings
    (on Render: your service → <b>Environment</b>):</p>
    <ul>${MISSING.map(m => `<li><code>${m}</code></li>`).join('')}</ul>
    <p>When you create your Spotify developer app, use this exact <b>Redirect URI</b>:</p>
    <p><code>${escapeHtml(REDIRECT_URI)}</code></p>`);
}

function connectedPage(refreshToken) {
  return infoPage('Connected! 🎉', `
    <p>Start playing something on Spotify, then share this jukebox's link with your guests.</p>
    <p><b>One more step if you're on Render (or any free cloud host):</b> copy the code below and add it in
    Render → <b>Environment</b> as a new variable named <code>SPOTIFY_REFRESH_TOKEN</code>.
    That keeps the jukebox logged in when Render restarts it. Treat it like a password.</p>
    <textarea id="t" readonly>${escapeHtml(refreshToken)}</textarea>
    <p><button onclick="navigator.clipboard.writeText(document.getElementById('t').value).then(() => this.textContent = 'Copied!')">Copy code</button></p>
    <p>Spotify will ask you to log in again in about 6 months. When it does, just repeat this and paste the new code.</p>`);
}

// ---------- Web server ----------

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
function sendJson(res, status, obj) { send(res, status, JSON.stringify(obj), 'application/json'); }

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 10_000) { reject(httpError(413, 'Request too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch { reject(httpError(400, 'Bad JSON')); }
    });
    req.on('error', reject);
  });
}

let oauthState = null;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = `${req.method} ${url.pathname}`;
  const html = 'text/html; charset=utf-8';
  try {
    if (MISSING.length) {
      if (url.pathname.startsWith('/api/')) return sendJson(res, 503, { error: "The jukebox isn't set up yet." });
      return send(res, 200, setupPage(), html);
    }
    switch (route) {
      case 'GET /':
        guestFor(req, res); // hand out the guest cookie on first visit
        return send(res, 200, PAGE, html);

      case 'GET /login': {
        if (url.searchParams.get('key') !== ADMIN_KEY) {
          return send(res, 403, infoPage('Wrong password', `
            <p>The <code>?key=</code> part of the link has to match your <code>ADMIN_KEY</code> setting exactly
            (capitals count).</p>`), html);
        }
        oauthState = crypto.randomBytes(16).toString('hex');
        const params = new URLSearchParams({
          response_type: 'code', client_id: CLIENT_ID, scope: SCOPES,
          redirect_uri: REDIRECT_URI, state: oauthState,
        });
        res.writeHead(302, { Location: 'https://accounts.spotify.com/authorize?' + params });
        return res.end();
      }

      case 'GET /callback': {
        if (!oauthState || url.searchParams.get('state') !== oauthState) {
          return send(res, 400, infoPage('Please try again', `
            <p>That login link was old or used twice. Open your <code>/login?key=…</code> link again.</p>`), html);
        }
        oauthState = null;
        if (url.searchParams.get('error')) {
          return send(res, 400, infoPage('Spotify login was cancelled',
            `<p>Spotify said: <code>${escapeHtml(url.searchParams.get('error'))}</code>. Open your login link again to retry.</p>`), html);
        }
        const d = await tokenRequest({
          grant_type: 'authorization_code', code: url.searchParams.get('code'), redirect_uri: REDIRECT_URI,
        });
        tokens = {
          access_token: d.access_token, refresh_token: d.refresh_token,
          expires_at: Date.now() + d.expires_in * 1000, authorized_at: Date.now(),
        };
        saveTokens();
        playback = null;
        return send(res, 200, connectedPage(tokens.refresh_token), html);
      }

      case 'GET /api/search': {
        const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
        if (!q) return sendJson(res, 400, { error: 'Type something to search for.' });
        return sendJson(res, 200, await searchTracks(q));
      }

      case 'POST /api/queue': {
        const body = await readJson(req);
        return sendJson(res, 200, await addSong(guestFor(req, res), String(body.uri || '')));
      }

      case 'POST /api/vote': {
        const body = await readJson(req);
        return sendJson(res, 200, toggleVote(guestFor(req, res), String(body.uri || '')));
      }

      case 'GET /api/now':
        return sendJson(res, 200, await nowState(guestFor(req, res)));

      default:
        return send(res, 404, 'Not found');
    }
  } catch (e) {
    const status = Number.isInteger(e.status) && e.status >= 400 && e.status < 600 ? e.status : 500;
    if (status >= 500 && status !== 503) console.error(e); // 503 = host not logged in; don't spam the log
    return sendJson(res, status, { error: friendlyError(e) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Jukebox running on port ${PORT}`);
  const base = new URL(REDIRECT_URI).origin;
  console.log(`Spotify Redirect URI: ${REDIRECT_URI}`);
  if (MISSING.length) console.log(`Open ${base} to see what's left to set up.`);
  else console.log(`Host login: ${base}/login?key=<your ADMIN_KEY>`);
  if (base.startsWith('http://127.0.0.1')) {
    console.log(`Guests on your Wi-Fi: http://<this computer's local IP>:${PORT}`);
  } else {
    console.log(`Guests: ${base}`);
  }
});

// ---------- Guest page ----------

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Party Jukebox</title>
<style>
  :root { color-scheme: dark; --bg: #121212; --card: #1e1e1e; --field: #2a2a2a; --text: #fff; --muted: #a7a7a7; --accent: #1ed760; --error: #ff6b6b; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.4 system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); }
  main { max-width: 560px; margin: 0 auto; padding: 16px; }
  h1 { font-size: 1.6rem; margin: 8px 0 16px; }
  h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 28px 0 8px; }
  form { display: flex; gap: 8px; }
  input { flex: 1; min-width: 0; padding: 12px 16px; border-radius: 999px; border: 0; background: var(--field); color: var(--text); font-size: 16px; }
  button { padding: 10px 16px; border-radius: 999px; border: 0; background: var(--accent); color: #000; font-weight: 700; font-size: 15px; cursor: pointer; flex: none; }
  button:disabled { opacity: .5; cursor: default; }
  button.vote { background: transparent; color: var(--text); border: 2px solid var(--muted); min-width: 64px; }
  button.vote[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: #000; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { display: flex; align-items: center; gap: 12px; padding: 8px; border-radius: 8px; }
  li:nth-child(odd) { background: var(--card); }
  img { width: 48px; height: 48px; border-radius: 4px; flex: none; background: var(--field); }
  .meta { flex: 1; min-width: 0; }
  .title, .artist { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .artist, .empty, .hint { color: var(--muted); font-size: .9rem; }
  .badge { flex: none; font-size: .8rem; font-weight: 700; color: var(--accent); }
  .hint { margin: -4px 4px 8px; }
  #msg { min-height: 1.4em; margin: 12px 4px 4px; color: var(--accent); }
  #msg.err, #problem { color: var(--error); }
  #problem { margin: 8px 4px 0; font-size: .9rem; }
</style>
</head>
<body>
<main>
  <h1>🎵 Party Jukebox</h1>
  <form id="search">
    <input id="q" placeholder="Search for a song or artist" autocomplete="off" required>
    <button>Search</button>
  </form>
  <p id="msg"></p>
  <ul id="results"></ul>
  <h2>Now playing</h2>
  <ul id="now"></ul>
  <p id="problem"></p>
  <h2>Up next</h2>
  <ul id="next"></ul>
  <h2>Vote for what plays next</h2>
  <p class="hint">Tap 👍 on the songs you want. Most votes plays first.</p>
  <ul id="waiting"></ul>
</main>
<script>
  const $ = id => document.getElementById(id);

  function say(text, isError) {
    $('msg').textContent = text;
    $('msg').className = isError ? 'err' : '';
  }

  function note(text) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = text;
    return li;
  }

  // One song row. Options: subtitle (extra text after the artist), badge, button {label, pressed, onClick, className}
  function row(track, options) {
    const opts = options || {};
    const li = document.createElement('li');
    const img = document.createElement('img');
    img.alt = '';
    if (track.image) img.src = track.image;
    const meta = document.createElement('div');
    meta.className = 'meta';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = track.name + (track.explicit ? ' (E)' : '');
    const artist = document.createElement('div');
    artist.className = 'artist';
    artist.textContent = track.artists + (opts.subtitle ? ' · ' + opts.subtitle : '');
    meta.append(title, artist);
    li.append(img, meta);
    if (opts.badge) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = opts.badge;
      li.append(badge);
    }
    if (opts.button) {
      const btn = document.createElement('button');
      btn.textContent = opts.button.label;
      if (opts.button.className) btn.className = opts.button.className;
      if (opts.button.pressed !== undefined) btn.setAttribute('aria-pressed', String(opts.button.pressed));
      btn.onclick = () => opts.button.onClick(btn);
      li.append(btn);
    }
    return li;
  }

  async function api(path, options) {
    const res = await fetch(path, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong');
    return data;
  }

  function post(path, uri) {
    return api(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uri: uri }),
    });
  }

  async function addSong(track, btn) {
    btn.disabled = true;
    try {
      const result = await post('/api/queue', track.uri);
      btn.textContent = 'Added';
      say(result.upvoted
        ? '"' + track.name + '" was already on the list, so we added your vote 👍'
        : 'Added "' + track.name + '" 🎉 Get your friends to vote for it!');
      refresh();
    } catch (err) {
      btn.disabled = false;
      say(err.message, true);
    }
  }

  async function vote(song, btn) {
    btn.disabled = true;
    try {
      await post('/api/vote', song.uri);
    } catch (err) {
      say(err.message, true);
    }
    refresh();
  }

  $('search').onsubmit = async event => {
    event.preventDefault();
    say('Searching…');
    try {
      const tracks = await api('/api/search?q=' + encodeURIComponent($('q').value));
      $('results').replaceChildren(...tracks.map(t => row(t, { button: { label: 'Add', onClick: btn => addSong(t, btn) } })));
      say(tracks.length ? '' : 'No results. Try different words.');
    } catch (err) {
      say(err.message, true);
    }
  };

  async function refresh() {
    try {
      const data = await api('/api/now');
      $('now').replaceChildren(data.current ? row(data.current) : note('Nothing playing right now'));
      $('problem').textContent = data.problem || '';
      $('next').replaceChildren(data.next
        ? row(data.next, { badge: '🔒 Locked in' })
        : note(data.waiting.length ? 'The top-voted song gets locked in near the end of this one' : 'Add a song to get things going!'));
      $('waiting').replaceChildren(...(data.waiting.length
        ? data.waiting.map(s => row(s, {
            subtitle: s.mine ? 'your pick' : '',
            button: { label: '👍 ' + s.votes, className: 'vote', pressed: s.voted, onClick: btn => vote(s, btn) },
          }))
        : [note('No requests yet. Search above to add one!')]));
    } catch (err) {
      $('problem').textContent = err.message;
    }
  }

  refresh();
  setInterval(refresh, 8000);
</script>
</body>
</html>`;
