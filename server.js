// Planar Bridge prototype server.
// Serves the web client and keeps each session's table state in memory.
// The server is the single source of truth; clients send small actions and get
// back a filtered copy of the table (hidden cards are sent without their faces).

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MAX_PLAYERS = 4;
const ZONES = ['library', 'hand', 'battlefield', 'graveyard', 'exile', 'command'];
const SEAT_COLORS = ['#e0a526', '#3b8fd9', '#d9534f', '#3fae6a'];
const ROOM_IDLE_MS = 1000 * 60 * 60 * 6; // forget empty rooms after 6 hours

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

// A JPEG sent as a data URL (already shrunk on the tablet), or null if it isn't one or is too big.
function jpegFrom(data, maxBytes) {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(data || ''));
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  return buf.length <= maxBytes && buf[0] === 0xff && buf[1] === 0xd8 ? buf : null;
}

// ---------- HTTP (static files) ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = decodeURIComponent(url.pathname);
  // A player's custom playmat image: /mat/<session code>/<player id>
  const mm = p.match(/^\/mat\/([A-Z0-9]{5})\/([\w-]{1,64})$/);
  if (mm) {
    const room = rooms.get(mm[1]);
    const pl = room && player(room, mm[2]);
    if (!pl || !pl.mat) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' });
    return res.end(pl.mat);
  }
  // The card back of the deck a player loaded, if it has a custom one: /back/<code>/<player id>
  const bm = p.match(/^\/back\/([A-Z0-9]{5})\/([\w-]{1,64})$/);
  if (bm) {
    const room = rooms.get(bm[1]);
    const pl = room && player(room, bm[2]);
    if (!pl || !pl.cardBack) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' });
    return res.end(pl.cardBack);
  }
  // Custom card art a player brought with their deck: /art/<code>/<player id>/<art id>
  const am = p.match(/^\/art\/([A-Z0-9]{5})\/([\w-]{1,64})\/([\w-]{1,40})$/);
  if (am) return artRoute(req, res, am[1], am[2], am[3]);
  if (p === '/' || p.startsWith('/s/')) p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// Card art is uploaded over HTTP before the deck is loaded (one picture per
// request, so a big deck never has to fit in one socket message). Pictures
// are kept in memory with the session, like playmats, and only for cards in
// the deck that player has loaded.
const ART_MAX_BYTES = 200 * 1024; // one card picture, already shrunk on the device
const ART_MAX_PER_PLAYER = 250;
const ART_MAX_TOTAL = 16 * 1024 * 1024; // per player, about 100 cards of art
function artRoute(req, res, code, playerId, artId) {
  const room = rooms.get(code);
  const pl = room && player(room, playerId);
  const art = pl && pl.art && pl.art.get(artId);
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (!art) { res.writeHead(404); return res.end(); }
    // An art id never changes picture, so it can be cached for good.
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': art.length, 'Cache-Control': 'private, max-age=31536000, immutable' });
    return res.end(req.method === 'HEAD' ? undefined : art);
  }
  if (req.method !== 'POST' || !pl) { res.writeHead(pl ? 405 : 404); return res.end(); }
  if (art) { res.writeHead(204); return res.end(); }
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > ART_MAX_BYTES) { res.writeHead(413); res.end(); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('error', () => {});
  req.on('end', () => {
    if (size > ART_MAX_BYTES) return;
    const buf = Buffer.concat(chunks);
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) { res.writeHead(415); return res.end(); }
    pl.art = pl.art || new Map();
    const full = () => pl.art.size >= ART_MAX_PER_PLAYER
      || [...pl.art.values()].reduce((n, b) => n + b.length, 0) + buf.length > ART_MAX_TOTAL;
    if (full()) {
      // Make room by dropping pictures the deck on the table doesn't use
      // (left over from a deck loaded earlier).
      const inUse = new Set();
      for (const c of room.cards.values()) if (c.owner === pl.id) { inUse.add(c.art); inUse.add(c.artBack); }
      for (const id of [...pl.art.keys()]) if (!inUse.has(id)) pl.art.delete(id);
    }
    if (full()) { res.writeHead(507); return res.end(); }
    pl.art.set(artId, buf);
    room.touched = Date.now();
    res.writeHead(201);
    res.end();
  });
}
function artPath(room, c, artId) {
  return `/art/${room.code}/${encodeURIComponent(c.owner)}/${encodeURIComponent(artId)}`;
}

// ---------- Room state ----------
const rooms = new Map();

function newCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[crypto.randomInt(chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function createRoom(startingLife) {
  const room = {
    code: newCode(),
    startingLife: [20, 30, 40].includes(startingLife) ? startingLife : 20,
    players: [], // {id, name, seat, life, zones:{...}, connected}
    cards: new Map(), // id -> card
    log: [],
    touched: Date.now(),
    sockets: new Set(),
  };
  rooms.set(room.code, room);
  return room;
}

function emptyZones() {
  return Object.fromEntries(ZONES.map((z) => [z, []]));
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function player(room, id) {
  return room.players.find((p) => p.id === id);
}

function addLog(room, text) {
  room.log.push({ t: Date.now(), text });
  if (room.log.length > 60) room.log.shift();
}

function removeFromZone(room, card) {
  const p = player(room, card.loc.player);
  if (!p) return;
  const list = p.zones[card.loc.zone];
  const i = list.indexOf(card.id);
  if (i >= 0) list.splice(i, 1);
}

// Put a card in a zone. Library index 0 is the top card.
function placeCard(room, card, toPlayer, toZone, opts = {}) {
  const p = player(room, toPlayer);
  if (!p || !ZONES.includes(toZone)) return false;
  // Only a commander goes in or out of the command zone, and only its owner's.
  if ((toZone === 'command' || card.loc.zone === 'command') && !card.commander) return false;
  if (toZone === 'command' && toPlayer !== card.owner) return false;
  removeFromZone(room, card);
  const leavingBattlefield = card.loc.zone === 'battlefield' && toZone !== 'battlefield';
  card.loc = { player: toPlayer, zone: toZone };
  if (toZone !== 'battlefield' || leavingBattlefield) card.tapped = false;
  if (toZone !== 'battlefield') { card.counters = 0; card.faceDown = false; }
  if (toZone !== 'battlefield' && toZone !== 'exile') card.transformed = false;
  if (toZone === 'battlefield') {
    card.x = clamp(opts.x ?? 0.05 + Math.random() * 0.3, 0, 0.94);
    card.y = clamp(opts.y ?? 0.1 + Math.random() * 0.4, 0, 0.9);
    if (opts.faceDown !== undefined) card.faceDown = !!opts.faceDown;
  }
  const list = p.zones[toZone];
  if (toZone === 'library' && opts.bottom) list.push(card.id);
  else if (toZone === 'library') list.unshift(card.id);
  else if (typeof opts.index === 'number') list.splice(clamp(opts.index, 0, list.length), 0, card.id);
  else list.push(card.id);
  return true;
}

// Put a player's commander(s) in their command zone (deck load and reset).
function commandersHome(room, p) {
  for (const c of room.cards.values()) {
    if (c.owner === p.id && c.commander) placeCard(room, c, p.id, 'command');
  }
}

function clamp(v, lo, hi) {
  v = Number(v);
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

function cleanStr(s, max) {
  return String(s ?? '').replace(/[\u0000-\u001f]/g, '').slice(0, max);
}

// Only allow card images from Scryfall's image CDN.
function cleanImg(u) {
  u = String(u || '');
  return /^https:\/\/(cards|c1|c2)\.scryfall\.io\//.test(u) ? u.slice(0, 300) : '';
}

// Remove every card a player owns (wherever it sits on the table).
function removeOwnedCards(room, ownerId) {
  for (const card of [...room.cards.values()]) {
    if (card.owner === ownerId) {
      removeFromZone(room, card);
      room.cards.delete(card.id);
    }
  }
}

// The pictures for each side of a card: the owner's custom art if they brought
// some, otherwise Scryfall's. A double-faced card keeps its second face either way.
function faces(room, c) {
  return {
    img: c.art ? artPath(room, c, c.art) : c.img,
    back: c.artBack ? artPath(room, c, c.artBack) : c.back,
  };
}

// What a given viewer is allowed to see.
function viewFor(room, viewerId) {
  const visible = (card) => {
    const z = card.loc.zone;
    if (z === 'library') return false;
    if (z === 'hand') return card.loc.player === viewerId;
    if (z === 'battlefield' && card.faceDown) return card.loc.player === viewerId; // controller can peek
    return true;
  };
  const cardView = (id) => {
    const c = room.cards.get(id);
    const base = { id: c.id, owner: c.owner };
    if (c.commander) base.commander = true;
    if (c.loc.zone === 'battlefield') Object.assign(base, { x: c.x, y: c.y, tapped: c.tapped, faceDown: c.faceDown, counters: c.counters });
    // Lets the receiving tablet animate a card sliding in from the sender's side.
    if (c.sentFrom && Date.now() - c.sentAt < 4000) Object.assign(base, { from: c.sentFrom, sentAt: c.sentAt });
    if (visible(c)) Object.assign(base, faces(room, c), { name: c.name, transformed: c.transformed, finish: c.finish || undefined });
    return base;
  };
  return {
    code: room.code,
    startingLife: room.startingLife,
    you: viewerId,
    log: room.log.slice(-25),
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      seat: p.seat,
      pos: p.pos,
      color: SEAT_COLORS[p.seat],
      life: p.life,
      shuffles: p.shuffles || 0, // lets every tablet play the shuffle motion
      hasCommander: [...room.cards.values()].some((c) => c.owner === p.id && c.commander),
      mat: p.mat ? p.matV : 0, // custom playmat version, fetched from /mat/<code>/<id>
      cardBack: p.cardBack ? p.backV : 0, // custom card back version, fetched from /back/<code>/<id>
      connected: p.connected,
      counts: Object.fromEntries(ZONES.map((z) => [z, p.zones[z].length])),
      zones: {
        library: [], // never sent; count is enough
        hand: p.zones.hand.map(cardView),
        battlefield: p.zones.battlefield.map(cardView),
        graveyard: p.zones.graveyard.map(cardView),
        exile: p.zones.exile.map(cardView),
        command: p.zones.command.map(cardView),
      },
    })),
  };
}

function broadcast(room) {
  room.touched = Date.now();
  for (const ws of room.sockets) {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'state', state: viewFor(room, ws.playerId) }));
  }
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function connectedCount(room, p) {
  let n = 0;
  for (const ws of room.sockets) if (ws.playerId === p.id) n++;
  return n;
}

// ---------- Actions ----------
function handle(ws, msg) {
  if (msg.type === 'create') {
    const room = createRoom(Number(msg.startingLife));
    return join(ws, room, msg.name, null);
  }
  if (msg.type === 'join') {
    const room = rooms.get(String(msg.code || '').toUpperCase().trim());
    if (!room) return send(ws, { type: 'error', error: 'No session with that code. Check the code or create a new session.' });
    return join(ws, room, msg.name, msg.playerId);
  }

  const room = ws.room;
  const me = room && player(room, ws.playerId);
  if (!me) return send(ws, { type: 'error', error: 'You are not in a session.' });

  // "Top of my library" stands in for a card id the client never sees.
  const cardId = msg.cardId === 'LIBRARY_TOP' ? me.zones.library[0] : msg.cardId;
  const card = cardId ? room.cards.get(cardId) : null;

  switch (msg.type) {
    case 'loadDeck': {
      const list = Array.isArray(msg.cards) ? msg.cards.slice(0, 250) : [];
      removeOwnedCards(room, me.id);
      // Custom art only counts if the picture was uploaded first.
      const artOf = (id) => (typeof id === 'string' && me.art && me.art.has(id) ? id : undefined);
      const usedArt = new Set();
      for (const c of list) {
        const id = crypto.randomUUID().slice(0, 12);
        const cardObj = {
          id,
          owner: me.id,
          name: cleanStr(c.name, 120),
          img: cleanImg(c.img),
          back: cleanImg(c.back),
          finish: c.finish === 'foil' || c.finish === 'etched' ? c.finish : '',
          loc: { player: me.id, zone: 'library' },
          tapped: false, faceDown: false, transformed: false, counters: 0, x: 0, y: 0,
        };
        room.cards.set(id, cardObj);
        me.zones.library.push(id);
        if (c.commander) cardObj.commander = true;
        const art = artOf(c.art);
        const artBack = cardObj.back ? artOf(c.artBack) : undefined;
        if (art) { cardObj.art = art; usedArt.add(art); }
        if (artBack) { cardObj.artBack = artBack; usedArt.add(artBack); }
      }
      // Let go of pictures from an earlier deck.
      if (me.art) for (const id of [...me.art.keys()]) if (!usedArt.has(id)) me.art.delete(id);
      // Each deck can bring its own card back; a deck without one uses the official back.
      me.cardBack = jpegFrom(msg.cardBack, 120 * 1024);
      me.backV = (me.backV || 0) + 1;
      shuffle(me.zones.library);
      me.shuffles = (me.shuffles || 0) + 1;
      commandersHome(room, me);
      addLog(room, `${me.name} loaded a ${list.length} card deck and shuffled.`);
      break;
    }
    case 'move': {
      if (!card) return;
      const from = card.loc;
      const to = player(room, msg.toPlayer);
      if (!to) return;
      const wasHidden = from.zone === 'library' || from.zone === 'hand';
      if (!placeCard(room, card, to.id, msg.toZone, { x: msg.x, y: msg.y, index: msg.index, bottom: msg.bottom, faceDown: msg.faceDown })) return;
      if (from.player !== to.id) { card.sentFrom = from.player; card.sentAt = Date.now(); } else card.sentFrom = null;
      if (!(from.player === to.id && from.zone === msg.toZone)) {
        const fromP = player(room, from.player);
        const shownName = (msg.toZone === 'library' || msg.toZone === 'hand' || card.faceDown) && wasHidden ? 'a card' : card.name;
        const where = to.id === from.player ? msg.toZone : `${to.name}'s ${msg.toZone}`;
        addLog(room, `${me.name} moved ${shownName} from ${fromP ? fromP.name + "'s " : ''}${from.zone} to ${where}.`);
      }
      break;
    }
    case 'tap': {
      if (!card || card.loc.zone !== 'battlefield') return;
      card.tapped = !card.tapped;
      break;
    }
    case 'flip': {
      // Double-faced cards transform; everything else turns face down / up.
      if (!card || card.loc.zone !== 'battlefield') return;
      if (card.back && !card.faceDown) card.transformed = !card.transformed;
      else card.faceDown = !card.faceDown;
      break;
    }
    case 'faceDown': {
      if (!card || card.loc.zone !== 'battlefield') return;
      card.faceDown = !card.faceDown;
      break;
    }
    case 'counter': {
      if (!card || card.loc.zone !== 'battlefield') return;
      card.counters = clamp((card.counters || 0) + Math.sign(Number(msg.delta) || 0), -99, 99);
      break;
    }
    case 'draw': {
      const n = clamp(Math.floor(msg.n || 1), 1, 20);
      let drawn = 0;
      for (let i = 0; i < n && me.zones.library.length; i++) {
        const c = room.cards.get(me.zones.library[0]);
        placeCard(room, c, me.id, 'hand');
        drawn++;
      }
      addLog(room, `${me.name} drew ${drawn} card${drawn === 1 ? '' : 's'}.`);
      break;
    }
    case 'mill': {
      const c = me.zones.library[0] && room.cards.get(me.zones.library[0]);
      if (!c) return;
      placeCard(room, c, me.id, 'graveyard');
      addLog(room, `${me.name} milled ${c.name}.`);
      break;
    }
    case 'searchLibrary': {
      // Only the searching player gets the card list.
      send(ws, { type: 'library', cards: me.zones.library.map((id) => {
        const c = room.cards.get(id);
        return { id: c.id, owner: c.owner, name: c.name, ...faces(room, c), finish: c.finish || undefined };
      }) });
      if (!msg.quiet) addLog(room, `${me.name} is looking through their library.`);
      break;
    }
    case 'shuffle': {
      shuffle(me.zones.library);
      me.shuffles = (me.shuffles || 0) + 1;
      addLog(room, `${me.name} shuffled their library.`);
      break;
    }
    case 'untapAll': {
      for (const id of me.zones.battlefield) room.cards.get(id).tapped = false;
      addLog(room, `${me.name} untapped everything.`);
      break;
    }
    case 'life': {
      const target = player(room, msg.playerId) || me;
      const delta = Math.trunc(Number(msg.delta) || 0);
      if (msg.set !== undefined) target.life = clamp(Math.trunc(msg.set), -999, 999);
      else target.life = clamp(target.life + delta, -999, 999);
      // Life changes come in bursts of taps; merge them into one log line.
      const last = room.log[room.log.length - 1];
      const key = `${me.id}>${target.id}`;
      if (last && last.lifeKey === key && Date.now() - last.t < 4000) {
        last.total += delta;
        last.t = Date.now();
        last.text = `${me.name} changed ${target.id === me.id ? 'their' : target.name + "'s"} life by ${last.total > 0 ? '+' : ''}${last.total} (now ${target.life}).`;
      } else {
        addLog(room, `${me.name} changed ${target.id === me.id ? 'their' : target.name + "'s"} life by ${delta > 0 ? '+' : ''}${delta} (now ${target.life}).`);
        Object.assign(room.log[room.log.length - 1], { lifeKey: key, total: delta });
      }
      break;
    }
    case 'newGame': {
      // Gather every card this player owns back into their library and shuffle.
      for (const c of room.cards.values()) {
        if (c.owner === me.id) placeCard(room, c, me.id, 'library');
      }
      shuffle(me.zones.library);
      me.shuffles = (me.shuffles || 0) + 1;
      commandersHome(room, me);
      me.life = room.startingLife;
      addLog(room, `${me.name} reset: all their cards back in library (commanders in the command zone), shuffled, life ${me.life}.`);
      break;
    }
    case 'seat': {
      // Move a player to another spot around the table (swapping with whoever is there).
      const target = player(room, msg.playerId);
      const pos = Math.trunc(Number(msg.pos));
      if (!target || ![0, 1, 2, 3].includes(pos)) return;
      const other = room.players.find((p) => p.pos === pos);
      if (other) other.pos = target.pos;
      target.pos = pos;
      addLog(room, `${me.name} changed the seating.`);
      break;
    }
    case 'playmat': {
      // A custom playmat picture, already shrunk to a JPEG on the tablet. null removes it.
      if (msg.data == null) { me.mat = null; me.matV = (me.matV || 0) + 1; break; }
      const buf = jpegFrom(msg.data, 240 * 1024);
      if (!buf) return send(ws, { type: 'error', error: "That picture couldn't be used as a playmat." });
      me.mat = buf;
      me.matV = (me.matV || 0) + 1;
      break;
    }
    case 'rename': {
      me.name = cleanStr(msg.name, 24) || me.name;
      break;
    }
    case 'leave': {
      removeOwnedCards(room, me.id);
      // Cards other people own that were sitting on my mat go back to their owner's graveyard.
      for (const z of ZONES) {
        for (const id of [...me.zones[z]]) {
          const c = room.cards.get(id);
          if (c) placeCard(room, c, c.owner, 'graveyard');
        }
      }
      room.players = room.players.filter((p) => p.id !== me.id);
      addLog(room, `${me.name} left the session.`);
      room.sockets.delete(ws);
      ws.room = null;
      ws.playerId = null;
      send(ws, { type: 'left' });
      break;
    }
    default:
      return;
  }
  broadcast(room);
}

function join(ws, room, name, playerId) {
  if (ws.room && ws.room !== room) ws.room.sockets.delete(ws);
  let p = playerId && player(room, playerId);
  if (!p) {
    if (room.players.length >= MAX_PLAYERS) {
      return send(ws, { type: 'error', error: 'This session already has 4 players.' });
    }
    const used = new Set(room.players.map((x) => x.seat));
    const seat = [0, 1, 2, 3].find((s) => !used.has(s));
    // Table positions go clockwise 0-3. Fill across from the first player first,
    // so two players face each other and a third sits to the side.
    const usedPos = new Set(room.players.map((x) => x.pos));
    const pos = [0, 2, 1, 3].find((n) => !usedPos.has(n));
    p = {
      id: crypto.randomUUID(),
      name: cleanStr(name, 24) || `Player ${seat + 1}`,
      seat,
      pos,
      life: room.startingLife,
      zones: emptyZones(),
      connected: true,
    };
    room.players.push(p);
    addLog(room, `${p.name} joined.`);
  }
  p.connected = true;
  ws.room = room;
  ws.playerId = p.id;
  room.sockets.add(ws);
  send(ws, { type: 'joined', code: room.code, playerId: p.id });
  broadcast(room);
}

// ---------- WebSocket ----------
// Room for a playmat picture (about 300 KB of text) plus headroom.
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 512 * 1024 });
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  // A bad or oversized message closes just this connection (the tablet reconnects)
  // instead of taking the whole server down.
  ws.on('error', (e) => console.error('socket error:', e.code || e.message));
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    try { handle(ws, msg); } catch (e) { console.error(e); }
  });
  ws.on('close', () => {
    const room = ws.room;
    if (!room) return;
    room.sockets.delete(ws);
    const p = player(room, ws.playerId);
    if (p && connectedCount(room, p) === 0) {
      p.connected = false;
      broadcast(room);
    }
  });
});

// Keep connections alive through proxies, and forget idle empty rooms.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
  for (const [code, room] of rooms) {
    if (room.sockets.size === 0 && Date.now() - room.touched > ROOM_IDLE_MS) rooms.delete(code);
  }
}, 30000);

server.listen(PORT, () => console.log(`Planar Bridge running on http://localhost:${PORT}`));
