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
//   REPEAT_WINDOW_MINUTES=45  a song (or any version of it: remix, live, remastered, clean, or a
//                             cover by another artist) can't be requested again until this long
//                             after it played
//   ALLOW_COVERS=true         treat versions by different artists as different songs (by default
//                             any song with the same title counts as the same song)
//   ALLOW_EXPLICIT=false      hide and block songs Spotify marks as Explicit (the "E" label)
//   WORD_FILTER=off           turn off the rude-word filter (it's on by default)
//   EXTRA_BLOCKED_WORDS=a,b   more words to block, comma-separated (whole words)
//   PARTY_NAME=...            the title shown on the page (default: ACJC Homecoming 96)
//   SPOTIFY_REFRESH_TOKEN=... lets the jukebox log itself back in after a restart on hosts
//                             that wipe files (e.g. Render's free tier). The /callback page
//                             shows you this value after you log in.
//
// Pages: /        the guest page, with the QR code at the top.
//        /screen  a big-screen view for a TV: QR code, now playing, up next and the vote list.
//        /admin   host controls: remove songs from the list, skip the current song.
//                 Open /admin?key=YOUR_ADMIN_KEY once; that browser stays signed in for a day.
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
const REPEAT_WINDOW_MS = Number(process.env.REPEAT_WINDOW_MINUTES || 45) * 60 * 1000;
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
    cover: (t.album?.images || t.images || [])[1]?.url || (t.album?.images || t.images || [])[0]?.url || '', // ~300px, for the big screen
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

// ---------- "Same song" detection (catches remixes, live, remastered, clean versions…) ----------
// Two tracks count as the same song when their titles match once the extras are stripped off
// ("Song (Remix)", "Song - Live", "Song - 2011 Remaster", "Song [feat. X]", "Song (Taylor's Version)"),
// whoever the artist is, so every "Amazing Grace" counts as one song. The catch: different songs
// that happen to share a title (Adele's "Hello" and Lionel Richie's "Hello") also count as one.
// Set ALLOW_COVERS=true to require a shared artist as well.
const ALLOW_COVERS = process.env.ALLOW_COVERS === 'true';

function plain(text) {
  return String(text || '').toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');
}

function baseTitle(name) {
  let t = plain(name);
  t = t.replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, ' ');   // anything in brackets
  t = t.split(/\s[-–—]\s/)[0];                              // anything after " - "
  t = t.replace(/\s(feat|ft|featuring)\.?\s.*$/, ' ');       // "Song feat. Someone"
  t = t.replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return t || plain(name).trim();
}

function songKey(track) {
  return {
    title: baseTitle(track.name),
    artists: new Set((track.artists || []).map(a => plain(a.name).replace(/[^\p{L}\p{N}]+/gu, ' ').trim())),
  };
}

function sameSong(a, b) {
  if (a.title !== b.title) return false;
  return !ALLOW_COVERS || [...a.artists].some(artist => b.artists.has(artist));
}

// Songs seen playing on Spotify (including your own playlist), so they can't be requested again too soon.
const history = []; // { key, at }

function rememberPlaying(track) {
  if (!track?.name) return;
  const key = songKey(track);
  const seen = history.find(h => sameSong(h.key, key));
  if (seen) seen.at = Date.now();
  else history.push({ key, at: Date.now() });
}

function playedRecently(key) {
  for (let i = history.length - 1; i >= 0; i--) {
    if (Date.now() - history[i].at > REPEAT_WINDOW_MS) history.splice(i, 1);
  }
  return history.find(h => sameSong(h.key, key));
}

const minutesUntilAllowed = h => Math.max(1, Math.ceil((h.at + REPEAT_WINDOW_MS - Date.now()) / 60_000));

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
    .map(t => ({ ...simplify(t), ...statusFor(t) }));
}

// Tells the search page whether a song (or a version of it) is playing, lined up, listed or played recently.
function statusFor(track) {
  const key = songKey(track);
  if (playback?.item && sameSong(songKey(playback.item), key)) return { status: 'playing' };
  if (playingNext && sameSong(playingNext.key, key)) return { status: 'next' };
  const listed = waiting.find(s => sameSong(s.key, key));
  if (listed) return { status: 'listed', listedUri: listed.uri };
  const recent = playedRecently(key);
  if (recent?.removed) return { status: 'removed' };
  if (recent) return { status: 'recent', minutes: minutesUntilAllowed(recent) };
  return {};
}

// ---------- What's playing (shared, cached so many guests don't hit Spotify's rate limit) ----------

let playback = null;     // last answer from Spotify's "playback state"
let playbackAt = 0;
let playbackPromise = null;

async function getPlayback() {
  if (playback && Date.now() - playbackAt < 4000) return playback;
  if (!playbackPromise) {
    playbackPromise = spotify('GET', '/me/player')
      .then(d => {
        playback = d || {}; // empty = no active device
        playbackAt = Date.now();
        rememberPlaying(playback.item);
        return playback;
      })
      .finally(() => { playbackPromise = null; });
  }
  return playbackPromise;
}

// ---------- The request list and voting ----------

const waiting = [];              // songs guests added, not yet handed to Spotify
let playingNext = null;          // the song we've handed to Spotify's queue that hasn't started yet
const lastAddByGuest = new Map(); // guest -> when they last added a song
const skipWhenPlaying = new Map(); // uri -> when the host removed it after it was already lined up
let feedProblem = '';            // last problem handing a song to Spotify, shown to guests

function ranked() {
  // Most votes first; ties go to whoever asked first.
  return [...waiting].sort((a, b) => b.votes.size - a.votes.size || a.addedAt - b.addedAt);
}

async function addSong(guest, uri, isHost = false) {
  if (!/^spotify:track:[A-Za-z0-9]{22}$/.test(uri)) throw httpError(400, "That doesn't look like a Spotify track.");

  // Already on the list? Count it as a vote instead.
  const existing = waiting.find(s => s.uri === uri);
  if (existing) {
    existing.votes.add(guest);
    return { upvoted: true, name: existing.name };
  }

  const wait = (lastAddByGuest.get(guest) || 0) + COOLDOWN_MS - Date.now();
  if (wait > 0 && !isHost) { // the host doesn't have to wait
    throw httpError(429, `Easy there! You can add another song in ${Math.ceil(wait / 1000)}s. Voting is unlimited 👍`);
  }
  if (waiting.length >= MAX_WAITING) throw httpError(429, 'The list is full right now. Vote for a song instead!');

  // Look the song up ourselves (don't trust the browser), and re-check the filters.
  const track = await spotify('GET', '/tracks/' + uri.split(':')[2]);
  if (!track?.uri) throw httpError(404, "Couldn't find that song.");
  if (!ALLOW_EXPLICIT && track.explicit) throw httpError(403, 'Explicit songs are turned off tonight.');
  if (isRudeTrack(track)) throw httpError(403, PARTY_FRIENDLY);

  // No repeats: the same song, or another version of it, can't be playing, lined up, listed twice,
  // or have played in the last REPEAT_WINDOW_MINUTES.
  const key = songKey(track);
  if (playback?.item && sameSong(songKey(playback.item), key)) throw httpError(409, "That song's playing right now! 🎶");
  if (playingNext && sameSong(playingNext.key, key)) throw httpError(409, "That song's already playing next! 🎶");
  const listed = waiting.find(s => sameSong(s.key, key));
  if (listed) {
    listed.votes.add(guest);
    return { upvoted: true, name: listed.name };
  }
  const recent = playedRecently(key);
  if (recent?.removed) throw httpError(409, 'The host took that one off the list. Try another song!');
  if (recent) {
    const mins = minutesUntilAllowed(recent);
    throw httpError(409, `That song (or a version of it) played recently. It can be requested again in about ${mins} min.`);
  }

  waiting.push({ ...simplify(track), key, addedAt: Date.now(), addedBy: guest, votes: new Set([guest]) });
  lastAddByGuest.set(guest, Date.now());
  feed(); // hands it to Spotify straight away if the current song is nearly over
  return { added: true };
}

// ---------- Host controls ----------

// Remove a song from the list. A removed song (and its other versions) can't be requested again
// for REPEAT_WINDOW_MINUTES. If it was already lined up in Spotify's queue, Spotify won't let apps
// take it out, so the jukebox skips it as soon as it starts.
function removeSong(uri) {
  const i = waiting.findIndex(s => s.uri === uri);
  if (i !== -1) {
    const [song] = waiting.splice(i, 1);
    history.push({ key: song.key, at: Date.now(), removed: true });
    return { removed: song.name };
  }
  if (playingNext?.uri === uri) {
    const song = playingNext;
    playingNext = null; // so the next top-voted song gets lined up behind it
    skipWhenPlaying.set(uri, Date.now());
    history.push({ key: song.key, at: Date.now(), removed: true });
    return { removed: song.name, willSkip: true };
  }
  throw httpError(404, "That song isn't on the list any more.");
}

async function skipCurrent() {
  await spotify('POST', '/me/player/next');
  playback = null; // look again next time someone asks
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
  if (feeding || !tokens || MISSING.length || (!waiting.length && !playingNext && !skipWhenPlaying.size)) return;
  feeding = true;
  try {
    const p = await getPlayback();
    const current = p.item;

    // A song the host removed after it was lined up has started: skip it.
    for (const [uri, at] of skipWhenPlaying) if (Date.now() - at > 30 * 60_000) skipWhenPlaying.delete(uri);
    if (current && skipWhenPlaying.has(current.uri)) {
      skipWhenPlaying.delete(current.uri);
      await skipCurrent();
      return;
    }

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

    // Drop any waiting song whose version played in the meantime (e.g. from your own playlist).
    for (const song of [...waiting]) {
      if (playedRecently(song.key)) waiting.splice(waiting.indexOf(song), 1);
    }
    if (!waiting.length) return;

    const top = ranked()[0];
    await spotify('POST', '/me/player/queue?uri=' + encodeURIComponent(top.uri));
    waiting.splice(waiting.indexOf(top), 1);
    playingNext = { ...top, sentAt: Date.now() };
    feedProblem = '';
  } catch (e) {
    feedProblem = friendlyError(e);
  } finally {
    feeding = false;
  }
}
setInterval(feed, 5000);

function publicSong(s) {
  return { uri: s.uri, name: s.name, artists: s.artists, image: s.image, cover: s.cover, explicit: s.explicit };
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

// ---------- The host: /admin?key=ADMIN_KEY gives this browser a host cookie ----------

const ADMIN_TOKEN = ADMIN_KEY ? crypto.createHash('sha256').update('jukebox-host:' + ADMIN_KEY).digest('hex') : '';

function isHost(req) {
  const match = /(?:^|;\s*)jb_host=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  return !!(match && ADMIN_TOKEN && crypto.timingSafeEqual(Buffer.from(match[1]), Buffer.from(ADMIN_TOKEN)));
}

function requireHost(req) {
  if (!isHost(req)) throw httpError(403, 'Only the host can do that. Open /admin?key=YOUR_ADMIN_KEY first.');
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
    <p>Spotify will ask you to log in again in about 6 months. When it does, just repeat this and paste the new code.</p>
    <p><b>Host controls</b> (remove or skip songs): open <code>/admin?key=YOUR_ADMIN_KEY</code> on your phone.</p>`);
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
        return send(res, 200, page('guest', req), html);

      case 'GET /screen': // big-screen view for a TV or projector
        return send(res, 200, page('screen', req), html);

      case 'GET /admin': { // host controls: remove and skip songs
        const key = url.searchParams.get('key');
        if (key !== null) {
          if (key !== ADMIN_KEY) {
            return send(res, 403, infoPage('Wrong password', `
              <p>The <code>?key=</code> part of the link has to match your <code>ADMIN_KEY</code> setting exactly
              (capitals count).</p>`), html);
          }
          // Remember this browser as the host for a day, then drop the password from the address bar.
          const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
          res.writeHead(302, {
            Location: '/admin',
            'Set-Cookie': `jb_host=${ADMIN_TOKEN}; Path=/; Max-Age=86400; SameSite=Lax; HttpOnly${secure}`,
          });
          return res.end();
        }
        if (!isHost(req)) {
          return send(res, 403, infoPage('Host controls', `
            <p>To sign in as the host, open <code>/admin?key=YOUR_ADMIN_KEY</code> (use your real ADMIN_KEY).</p>`), html);
        }
        guestFor(req, res);
        return send(res, 200, page('admin', req), html);
      }

      case 'POST /api/admin/remove': {
        requireHost(req);
        const body = await readJson(req);
        return sendJson(res, 200, removeSong(String(body.uri || '')));
      }

      case 'POST /api/admin/skip': {
        requireHost(req);
        await skipCurrent();
        return sendJson(res, 200, { skipped: true });
      }

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
        return sendJson(res, 200, await addSong(guestFor(req, res), String(body.uri || ''), isHost(req)));
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

// ---------- Guest page and big-screen page ----------

const PARTY_NAME = process.env.PARTY_NAME || 'ACJC Homecoming 96';

// The QR code guests scan (made at generatorqr.com; it redirects to this jukebox).
const QR_IMAGE = 'data:image/png;base64,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';

// mode: 'guest' (the normal page), 'screen' (TV view) or 'admin' (host controls)
function page(mode, req) {
  const screen = mode === 'screen';
  const admin = mode === 'admin';
  const name = escapeHtml(PARTY_NAME);
  const host = escapeHtml(req.headers['x-forwarded-host'] || req.headers.host || '');
  const qr = `<img class="qr" src="${QR_IMAGE}" alt="QR code to open the jukebox">`;
  const cta = `<p class="cta">Scan to pick the music &amp; vote 🎶</p><p class="url">${host}</p>`;

  const body = screen ? `
  <div class="hero">${qr}<div><h1>${name}</h1>${cta}</div></div>
  <div class="cols">
    <section>
      <h2>Now playing</h2>
      <ul id="now"></ul>
      <p id="problem"></p>
      <h2>Up next</h2>
      <ul id="next"></ul>
    </section>
    <section>
      <h2>Vote for what plays next</h2>
      <ul id="waiting"></ul>
    </section>
  </div>` : `
  ${admin
    ? `<p class="host-bar">🎛️ Host controls: tap ✕ twice to remove a song. <a href="/screen">TV view</a> · <a href="/">Guest page</a></p>`
    : `<div class="hero">${qr}<div>${cta}</div></div>`}
  <h1>${name}</h1>
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
  <ul id="waiting"></ul>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name}</title>
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

  /* Host controls */
  .host-bar { background: #2b2410; border: 1px solid #6b5a1e; color: #f5d76e; border-radius: 8px; padding: 10px 12px; font-size: .9rem; margin: 0 0 8px; }
  .host-bar a { color: #f5d76e; }
  button.remove { background: transparent; color: var(--error); border: 2px solid var(--error); min-width: 44px; padding: 8px 12px; }
  button.remove.armed { background: var(--error); color: #000; }

  /* QR code block at the top: always shown, at every screen size */
  .hero { display: flex; align-items: center; gap: 20px; margin: 8px 0 16px; }
  .hero .qr { width: 160px; height: 160px; padding: 8px; border-radius: 12px; background: #fff; flex: none; }
  .cta { font-size: 1.25rem; font-weight: 700; color: var(--accent); margin: 0 0 6px; }
  .url { color: var(--muted); margin: 0; word-break: break-all; }

  /* Big-screen view (/screen): sized to read from across the room */
  body.screen main { max-width: none; padding: 4vh 4vw; }
  body.screen .hero { display: flex; gap: 3vw; margin: 0 0 3vh; }
  body.screen .hero .qr { width: min(36vh, 30vw); height: min(36vh, 30vw); padding: 1.2vh; }
  body.screen h1 { font-size: clamp(2rem, 6vw, 7rem); line-height: 1.05; margin: 0 0 1.5vh; }
  body.screen .cta { font-size: clamp(1.2rem, 2.8vw, 3.2rem); }
  body.screen .url { font-size: clamp(1rem, 1.6vw, 2rem); }
  body.screen .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 4vw; }
  body.screen h2 { font-size: clamp(.9rem, 1.4vw, 1.8rem); margin: 2vh 0 1vh; }
  body.screen li { gap: 1.2vw; padding: 1vh 1vw; font-size: clamp(1rem, 1.8vw, 2.4rem); }
  body.screen li img { width: max(48px, 5vw); height: max(48px, 5vw); }
  body.screen li img.big { width: max(96px, 11vw); height: max(96px, 11vw); }
  body.screen .artist { font-size: .8em; }
  body.screen li.empty { font-size: clamp(.9rem, 1.5vw, 2rem); }
  body.screen .badge { font-size: 1em; }
  body.screen #problem { font-size: clamp(1rem, 1.5vw, 1.8rem); }
  @media (max-width: 800px) {
    body.screen .cols { grid-template-columns: 1fr; }
    body.screen .hero { flex-direction: column; text-align: center; }
  }
</style>
</head>
<body${screen ? ' class="screen"' : admin ? ' class="admin"' : ''}>
<main>${body}
</main>
<script>
  const $ = id => document.getElementById(id);
  const SCREEN = document.body.classList.contains('screen');
  const ADMIN = document.body.classList.contains('admin');
  let holdRefreshUntil = 0; // pause redrawing while the host decides on a two-tap button

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

  // Risky buttons need two taps: the first turns it into "Sure?", the second does it.
  function confirmTap(btn, b) {
    if (btn.classList.contains('armed')) {
      holdRefreshUntil = 0;
      b.onClick(btn);
      return;
    }
    btn.classList.add('armed');
    btn.textContent = 'Sure?';
    holdRefreshUntil = Date.now() + 4000;
    setTimeout(() => {
      if (btn.classList.contains('armed')) { btn.classList.remove('armed'); btn.textContent = b.label; }
    }, 4000);
  }

  // One song row. Options: subtitle (extra text after the artist), badge, big (large cover),
  // buttons: [{label, onClick, className, pressed, disabled, confirm}] (or a single "button")
  function row(track, options) {
    const opts = options || {};
    const li = document.createElement('li');
    const img = document.createElement('img');
    img.alt = '';
    if (opts.big && track.cover) { img.src = track.cover; img.className = 'big'; }
    else if (track.image) img.src = track.image;
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
    const buttons = opts.buttons || (opts.button ? [opts.button] : []);
    buttons.forEach(b => {
      const btn = document.createElement('button');
      btn.textContent = b.label;
      if (b.className) btn.className = b.className;
      if (b.pressed !== undefined) btn.setAttribute('aria-pressed', String(b.pressed));
      if (b.disabled) btn.disabled = true;
      else if (b.confirm) btn.onclick = () => confirmTap(btn, b);
      else btn.onclick = () => b.onClick(btn);
      li.append(btn);
    });
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
      btn.textContent = result.upvoted ? 'Voted' : 'Added';
      say(result.upvoted
        ? '"' + (result.name || track.name) + '" is already on the list, so we added your vote 👍'
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

  // Host only: remove a song, or skip the one playing.
  async function hostAction(path, uri, btn, doneText) {
    btn.disabled = true;
    try {
      const result = await post(path, uri);
      say(doneText(result));
    } catch (err) {
      say(err.message, true);
    }
    refresh();
  }

  function removeButton(song) {
    return {
      label: '✕', className: 'remove', confirm: true,
      onClick: btn => hostAction('/api/admin/remove', song.uri, btn, r => 'Removed "' + r.removed + '"'
        + (r.willSkip ? '. It was already lined up in Spotify, so it will be skipped as soon as it starts.' : '')),
    };
  }

  // What the button next to a search result does, depending on whether the song
  // (or another version of it) is already playing, lined up, on the list, or played recently.
  function searchOptions(t) {
    if (t.status === 'playing') return { button: { label: 'Playing', disabled: true } };
    if (t.status === 'next') return { button: { label: 'Up next', disabled: true } };
    if (t.status === 'listed') {
      return { subtitle: 'on the list', button: { label: '👍 Vote', onClick: btn => addSong({ name: t.name, uri: t.listedUri }, btn) } };
    }
    if (t.status === 'recent') {
      return { subtitle: 'played recently, back in ' + t.minutes + ' min', button: { label: 'Played', disabled: true } };
    }
    if (t.status === 'removed') return { subtitle: 'removed by the host', button: { label: 'Removed', disabled: true } };
    return { button: { label: 'Add', onClick: btn => addSong(t, btn) } };
  }

  if ($('search')) $('search').onsubmit = async event => {
    event.preventDefault();
    say('Searching…');
    try {
      const tracks = await api('/api/search?q=' + encodeURIComponent($('q').value));
      $('results').replaceChildren(...tracks.map(t => row(t, searchOptions(t))));
      say(tracks.length ? '' : 'No results. Try different words.');
    } catch (err) {
      say(err.message, true);
    }
  };

  async function refresh() {
    if (Date.now() < holdRefreshUntil) return;
    try {
      const data = await api('/api/now');
      $('now').replaceChildren(data.current
        ? row(data.current, ADMIN
          ? { buttons: [{ label: 'Skip ⏭', className: 'remove', confirm: true,
              onClick: btn => hostAction('/api/admin/skip', '', btn, () => 'Skipped ⏭') }] }
          : { big: SCREEN })
        : note('Nothing playing right now'));
      $('problem').textContent = data.problem || '';
      $('next').replaceChildren(data.next
        ? row(data.next, ADMIN ? { badge: '🔒', buttons: [removeButton(data.next)] } : { badge: '🔒 Locked in' })
        : note(data.waiting.length ? 'The top-voted song gets locked in near the end of this one' : 'Add a song to get things going!'));
      if (SCREEN) {
        // Big screen: show the top 7 with their vote counts (no buttons, nobody taps the TV)
        $('waiting').replaceChildren(...(data.waiting.length
          ? data.waiting.slice(0, 7).map(s => row(s, { badge: '👍 ' + s.votes }))
          : [note('No requests yet. Scan the code to add one!')]));
        return;
      }
      $('waiting').replaceChildren(...(data.waiting.length
        ? data.waiting.map(s => row(s, {
            subtitle: s.mine ? 'your pick' : '',
            buttons: [{ label: '👍 ' + s.votes, className: 'vote', pressed: s.voted, onClick: btn => vote(s, btn) }]
              .concat(ADMIN ? [removeButton(s)] : []),
          }))
        : [note('No requests yet. Search above to add one!')]));
    } catch (err) {
      $('problem').textContent = err.message;
    }
  }

  refresh();
  setInterval(refresh, SCREEN ? 5000 : 8000);
</script>
</body>
</html>`;
}
