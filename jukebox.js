// jukebox.js — a party jukebox for your Spotify. Node 18+, no dependencies.
//
// Guests search for songs on a web page and add them to YOUR Spotify queue.
// Only you (the host) ever log in to Spotify; guests just use the page.
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
//   COOLDOWN_SECONDS=30       how long each guest waits between requests
//   ALLOW_EXPLICIT=false      hide and block songs Spotify marks as Explicit (the "E" label)
//   WORD_FILTER=off           turn off the rude-word filter (it's on by default)
//   EXTRA_BLOCKED_WORDS=a,b   more words to block, comma-separated (whole words)
//   SPOTIFY_REFRESH_TOKEN=... lets the jukebox log itself back in after a restart on hosts
//                             that wipe files (e.g. Render's free tier). The /callback page
//                             shows you this value after you log in.

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
const ALLOW_EXPLICIT = process.env.ALLOW_EXPLICIT !== 'false';
const WORD_FILTER = process.env.WORD_FILTER !== 'off';
const DUPLICATE_WINDOW_MS = 60 * 60 * 1000; // same song can't be re-requested within 1 hour
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

// ---------- Jukebox logic ----------

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
    .normalize('NFKD').replace(/[̀-ͯ]/g, '') // "fück" -> "fuck"
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

let nowCache = null;
let nowCacheAt = 0;
async function nowAndNext() {
  // Cache for 10s so lots of guests polling the page don't burn through Spotify's rate limit.
  if (nowCache && Date.now() - nowCacheAt < 10_000) return nowCache;
  const data = await spotify('GET', '/me/player/queue');
  nowCache = {
    current: data?.currently_playing ? simplify(data.currently_playing) : null,
    queue: (data?.queue || []).slice(0, 10).map(simplify),
  };
  nowCacheAt = Date.now();
  return nowCache;
}

const lastRequestByGuest = new Map(); // ip -> timestamp
const recentTracks = new Map();       // uri -> timestamp

function guestId(req) {
  // Behind a tunnel or hosting proxy every guest shares one socket IP, so prefer the
  // headers the proxy adds (Cloudflare: CF-Connecting-IP; most others: X-Forwarded-For).
  // (Spoofable, but fine for a party.)
  return req.headers['cf-connecting-ip']
    || req.headers['x-forwarded-for']?.split(',')[0].trim()
    || req.socket.remoteAddress;
}

async function requestSong(req, uri) {
  if (!/^spotify:track:[A-Za-z0-9]{22}$/.test(uri)) throw httpError(400, "That doesn't look like a Spotify track.");

  const guest = guestId(req);
  const wait = (lastRequestByGuest.get(guest) || 0) + COOLDOWN_MS - Date.now();
  if (wait > 0) throw httpError(429, `Easy there! You can add another song in ${Math.ceil(wait / 1000)}s.`);

  const last = recentTracks.get(uri);
  if (last && Date.now() - last < DUPLICATE_WINDOW_MS) throw httpError(409, 'Someone already requested that one recently.');

  // Re-check the song itself, in case someone bypasses the search page.
  if (!ALLOW_EXPLICIT || WORD_FILTER) {
    const track = await spotify('GET', '/tracks/' + uri.split(':')[2]);
    if (!ALLOW_EXPLICIT && track?.explicit) throw httpError(403, 'Explicit songs are turned off tonight.');
    if (track && isRudeTrack(track)) throw httpError(403, PARTY_FRIENDLY);
  }

  // Note: the Web API can add to the queue but cannot remove or reorder queued songs.
  await spotify('POST', '/me/player/queue?uri=' + encodeURIComponent(uri));

  lastRequestByGuest.set(guest, Date.now());
  recentTracks.set(uri, Date.now());
  nowCache = null;
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
        nowCache = null;
        return send(res, 200, connectedPage(tokens.refresh_token), html);
      }

      case 'GET /api/search': {
        const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
        if (!q) return sendJson(res, 400, { error: 'Type something to search for.' });
        return sendJson(res, 200, await searchTracks(q));
      }

      case 'POST /api/queue': {
        const body = await readJson(req);
        await requestSong(req, String(body.uri || ''));
        return sendJson(res, 200, { ok: true });
      }

      case 'GET /api/now':
        return sendJson(res, 200, await nowAndNext());

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
  ul { list-style: none; padding: 0; margin: 0; }
  li { display: flex; align-items: center; gap: 12px; padding: 8px; border-radius: 8px; }
  li:nth-child(odd) { background: var(--card); }
  img { width: 48px; height: 48px; border-radius: 4px; flex: none; background: var(--field); }
  .meta { flex: 1; min-width: 0; }
  .title, .artist { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .artist, .empty { color: var(--muted); font-size: .9rem; }
  #msg { min-height: 1.4em; margin: 12px 4px 4px; color: var(--accent); }
  #msg.err { color: var(--error); }
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
  <h2>Up next</h2>
  <ul id="next"></ul>
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

  function row(track, onAdd) {
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
    artist.textContent = track.artists;
    meta.append(title, artist);
    li.append(img, meta);
    if (onAdd) {
      const btn = document.createElement('button');
      btn.textContent = 'Add';
      btn.onclick = () => onAdd(btn);
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

  async function addSong(track, btn) {
    btn.disabled = true;
    try {
      await api('/api/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uri: track.uri }),
      });
      btn.textContent = 'Added';
      say('Added "' + track.name + '" to the queue 🎉');
      refresh();
    } catch (err) {
      btn.disabled = false;
      say(err.message, true);
    }
  }

  $('search').onsubmit = async event => {
    event.preventDefault();
    say('Searching…');
    try {
      const tracks = await api('/api/search?q=' + encodeURIComponent($('q').value));
      $('results').replaceChildren(...tracks.map(t => row(t, btn => addSong(t, btn))));
      say(tracks.length ? '' : 'No results. Try different words.');
    } catch (err) {
      say(err.message, true);
    }
  };

  async function refresh() {
    try {
      const data = await api('/api/now');
      $('now').replaceChildren(data.current ? row(data.current) : note('Nothing playing right now'));
      $('next').replaceChildren(...(data.queue.length ? data.queue.map(t => row(t)) : [note('Queue is empty')]));
    } catch (err) {
      $('now').replaceChildren(note(err.message));
      $('next').replaceChildren();
    }
  }

  refresh();
  setInterval(refresh, 15000);
</script>
</body>
</html>`;
