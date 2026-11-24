// Planar Bridge prototype client (no build step, no framework).
'use strict';

const $ = (sel, el = document) => el.querySelector(sel);
const ZONE_LABEL = { library: 'Library', hand: 'Hand', battlefield: 'Battlefield', graveyard: 'Graveyard', exile: 'Exile' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const app = {
  ws: null,
  queue: [],
  retry: 0,
  code: null,
  playerId: null,
  s: null, // latest table state from server
  library: null, // my library contents while searching it
  cardEls: new Map(),
  matEls: new Map(),
  focus: null, // opponent whose full playmat is open
};

// ---------- Connection ----------
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  app.ws = ws;
  ws.onopen = () => {
    app.retry = 0;
    banner(null);
    if (app.code && app.playerId) rawSend({ type: 'join', code: app.code, playerId: app.playerId });
    while (app.queue.length) rawSend(app.queue.shift());
  };
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onclose = () => {
    if (app.code) banner('Connection lost. Reconnecting…');
    setTimeout(connect, Math.min(8000, 400 * 2 ** app.retry++));
  };
}
function rawSend(msg) { app.ws.send(JSON.stringify(msg)); }
function send(msg) {
  if (app.ws && app.ws.readyState === 1) rawSend(msg);
  else app.queue.push(msg);
}

function onMessage(msg) {
  if (msg.type === 'joined') {
    app.code = msg.code;
    app.playerId = msg.playerId;
    try { localStorage.setItem('ps:' + msg.code, msg.playerId); } catch {}
    history.replaceState(null, '', '/s/' + msg.code);
    $('#landing').hidden = true;
    $('#game').hidden = false;
    $('#codeLabel').textContent = msg.code;
  } else if (msg.type === 'state') {
    app.s = msg.state;
    render();
    if (app.pendingDeck) bringPendingDeck();
    if (app.library && sheetKind === 'library') send({ type: 'searchLibrary', quiet: true });
  } else if (msg.type === 'library') {
    app.library = msg.cards;
    if (sheetKind === 'library') renderLibrarySheet();
  } else if (msg.type === 'error') {
    if (!$('#game').hidden && app.s) toast(msg.error);
    else showLanding(msg.error);
    if (!app.s) { app.code = null; app.playerId = null; app.pendingDeck = null; }
  } else if (msg.type === 'left') {
    try { localStorage.removeItem('ps:' + app.code); } catch {}
    app.code = null; app.playerId = null; app.s = null;
    location.href = '/';
  }
}

// ---------- Landing ----------
function showLanding(err) {
  $('#game').hidden = true;
  $('#landing').hidden = false;
  $('#landingError').textContent = err || '';
}
function savedName() { try { return localStorage.getItem('ps:name') || ''; } catch { return ''; } }
function rememberName(n) { try { localStorage.setItem('ps:name', n); } catch {} }

$('#createBtn').onclick = () => {
  const name = $('#nameInput').value.trim();
  rememberName(name);
  app.pendingDeck = pickedDeck();
  send({ type: 'create', name, startingLife: Number($('#lifeSelect').value) });
};
$('#joinBtn').onclick = () => {
  const name = $('#nameInput').value.trim();
  const code = $('#codeInput').value.trim().toUpperCase();
  if (!code) return ($('#landingError').textContent = 'Enter the 5 letter session code.');
  rememberName(name);
  let pid = null;
  try { pid = localStorage.getItem('ps:' + code); } catch {}
  app.pendingDeck = pickedDeck();
  send({ type: 'join', code, name, playerId: pid });
};
$('#codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#joinBtn').click(); });

function boot() {
  $('#nameInput').value = savedName();
  renderLandingDecks();
  const m = location.pathname.match(/^\/s\/([A-Za-z0-9]{5})/);
  if (m) {
    const code = m[1].toUpperCase();
    let pid = null;
    try { pid = localStorage.getItem('ps:' + code); } catch {}
    $('#codeInput').value = code;
    if (pid) { app.code = code; app.playerId = pid; return connect(); } // join is sent on open
  }
  showLanding();
  connect();
}

// ---------- Helpers ----------
function me() { return app.s && app.s.players.find((p) => p.id === app.s.you); }
function playerById(id) { return app.s && app.s.players.find((p) => p.id === id); }
function findCard(id) {
  if (!app.s) return null;
  for (const p of app.s.players) {
    for (const z of ['hand', 'battlefield', 'graveyard', 'exile']) {
      const c = p.zones[z].find((x) => x.id === id);
      if (c) return { card: c, player: p, zone: z };
    }
  }
  const lib = app.library && app.library.find((x) => x.id === id);
  if (lib) return { card: lib, player: me(), zone: 'library' };
  return null;
}
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2600);
}
function banner(text) {
  $('#banner').hidden = !text;
  $('#banner').textContent = text || '';
}

// ---------- Rendering ----------
// Layout (one tablet per player, sitting around a real table):
// your playmat fills the screen, and each other player is a band on the edge
// of the screen that faces where they sit: left, across (top) or right.
const REL_NAME = { 1: 'left', 2: 'across', 3: 'right' };
function relOf(p, from = me()) { return (p.pos - from.pos + 4) % 4; }
function playerAtRel(rel) { const m = me(); return app.s.players.find((p) => p !== m && relOf(p, m) === rel); }

function render() {
  const s = app.s;
  const mine = me();
  if (!s || !mine) return;
  const used = new Set();
  if (app.focus && !playerById(app.focus)) app.focus = null;

  // Edge bands
  for (const rel of [1, 2, 3]) updateEdge($(`.edge[data-rel="${rel}"]`), playerAtRel(rel), rel);

  // Another player's playmat, opened from their band
  const focusP = app.focus && playerById(app.focus);
  const focus = $('#focusArea');
  focus.hidden = !focusP;
  if (focusP) {
    focus.dataset.rel = relOf(focusP);
    const mat = matFor(focusP);
    syncChildren(focus, [mat]);
    updateMat(mat, focusP, used);
  } else syncChildren(focus, []);

  // My playmat
  const myMat = matFor(mine);
  syncChildren($('#myArea'), [myMat]);
  updateMat(myMat, mine, used);
  $('#myLife').textContent = mine.life;
  $('#myLife').classList.toggle('low', mine.life <= 5);
  $('#game').style.setProperty('--my-seat', mine.color);

  for (const [id, mat] of app.matEls) {
    if (!playerById(id)) { mat.remove(); app.matEls.delete(id); }
  }

  // My hand
  const hand = $('#hand');
  $('#handCount').textContent = mine.zones.hand.length;
  $('#handBar').dataset.player = mine.id;
  syncChildren(hand, mine.zones.hand.map((c) => cardEl(c, 'hand', mine, used)));
  layoutHand();

  // Drop cards we no longer show anywhere
  for (const [id, el] of app.cardEls) if (!used.has(id)) { el.remove(); app.cardEls.delete(id); }

  renderLog();
  if (sheetKind === 'pile') renderPileSheet();
  if (sheetKind === 'seating') renderSeatingSheet();
}

function matFor(p) {
  let mat = app.matEls.get(p.id);
  if (!mat) { mat = createMat(p); app.matEls.set(p.id, mat); }
  return mat;
}

function setFocus(id) {
  app.focus = app.focus === id ? null : id;
  render();
}

function updateEdge(el, p, rel) {
  el.classList.toggle('empty', !p);
  if (!p) {
    delete el.dataset.drop; delete el.dataset.player; delete el.dataset.zone;
    el.style.removeProperty('--seat');
    const open = app.s.players.length < 4;
    el.innerHTML = `<span class="edge-inner"><span class="muted">${rel === 2 && open ? `Invite: <b class="edge-code">${esc(app.code)}</b>` : 'Empty seat'}</span></span>`;
    return;
  }
  el.dataset.drop = '1';
  el.dataset.zone = 'battlefield';
  el.dataset.player = p.id;
  el.style.setProperty('--seat', p.color);
  el.classList.toggle('focused', app.focus === p.id);
  el.innerHTML = `<span class="edge-inner"><span class="dot"></span><b>${esc(p.name)}</b>${p.connected ? '' : ' <span class="offline">offline</span>'}
    <span class="edge-life${p.life <= 5 ? ' low' : ''}">${p.life}</span>
    <span class="muted">Hand ${p.counts.hand} · Board ${p.counts.battlefield}</span></span>`;
}

// Tapping a band opens that player's playmat; tapping an empty band opens seating.
document.querySelectorAll('.edge').forEach((el) => {
  el.addEventListener('click', () => {
    if (drag) return;
    if (el.dataset.player) setFocus(el.dataset.player);
    else if (el.querySelector('.edge-code')) $('#inviteBtn').click();
    else openSeatingSheet();
  });
});

// Where a card sent by another player should land on the receiver's playmat:
// near the receiver's edge that faces the sender.
function landingSpot(sender, receiver) {
  const rel = relOf(sender, receiver);
  const r = Math.random();
  if (rel === 1) return { x: 0.03 + r * 0.08, y: 0.2 + Math.random() * 0.45 };
  if (rel === 3) return { x: 0.8 + r * 0.08, y: 0.2 + Math.random() * 0.45 };
  return { x: 0.25 + r * 0.45, y: 0.03 + Math.random() * 0.06 };
}

// Animate a card that just arrived from another player, sliding in from their side.
const arrived = new Set();
function maybeAnimateArrival(el, c, holder) {
  if (!c.from || holder.id !== app.s.you || c.from === app.s.you) return;
  const key = c.id + ':' + c.sentAt;
  if (arrived.has(key)) return;
  arrived.add(key);
  if (Date.now() - c.sentAt > 3000 || !el.animate) return;
  const sender = playerById(c.from);
  if (!sender) return;
  const rel = relOf(sender);
  const off = { 1: 'translate(-60vw, 0) rotate(-25deg)', 2: 'translate(0, -70vh) rotate(180deg)', 3: 'translate(60vw, 0) rotate(25deg)' }[rel];
  if (!off) return;
  requestAnimationFrame(() => el.animate([{ transform: off, opacity: 0.6 }, { transform: 'none', opacity: 1 }], { duration: 520, easing: 'cubic-bezier(.15,.85,.25,1)' }));
}

function syncChildren(parent, els) {
  els.forEach((el, i) => { if (parent.children[i] !== el) parent.insertBefore(el, parent.children[i] || null); });
  while (parent.children.length > els.length) parent.lastElementChild.remove();
}

function createMat(p) {
  const mat = document.createElement('section');
  mat.className = 'mat';
  mat.dataset.player = p.id;
  mat.innerHTML = `
    <div class="mat-head">
      <div class="mat-name"><span class="dot"></span><span class="nm"></span><span class="you"></span><span class="offline"></span></div>
      <span class="hand-badge" data-drop="1" data-zone="hand" data-player="${p.id}"></span>
      <div class="life">
        <button data-life="-1" aria-label="Lose 1 life">−</button>
        <span class="val"></span>
        <button data-life="1" aria-label="Gain 1 life">+</button>
      </div>
      <button class="btn small mat-close" aria-label="Close this playmat">Close</button>
    </div>
    <div class="mat-body">
      <div class="battlefield" data-drop="1" data-zone="battlefield" data-player="${p.id}"></div>
      <div class="piles">
        <div class="pile library" data-drop="1" data-zone="library" data-player="${p.id}"><div class="library-back"></div><span class="count"></span><span class="pile-label">Library</span></div>
        <div class="pile graveyard" data-drop="1" data-zone="graveyard" data-player="${p.id}"><div class="slot"></div><span class="count"></span><span class="pile-label">Graveyard</span></div>
        <div class="pile exile" data-drop="1" data-zone="exile" data-player="${p.id}"><div class="slot"></div><span class="count"></span><span class="pile-label">Exile</span></div>
      </div>
    </div>`;
  mat.querySelectorAll('[data-life]').forEach((b) => {
    b.onclick = () => send({ type: 'life', playerId: p.id, delta: Number(b.dataset.life) });
  });
  $('.mat-close', mat).onclick = () => setFocus(p.id);
  return mat;
}

function updateMat(mat, p, used) {
  const isMe = p.id === app.s.you;
  mat.classList.toggle('me', isMe);
  mat.style.setProperty('--seat', p.color);
  $('.nm', mat).textContent = p.name;
  $('.you', mat).textContent = isMe ? '(you)' : '';
  $('.offline', mat).textContent = p.connected ? '' : 'offline';
  const lv = $('.life .val', mat);
  lv.textContent = p.life;
  lv.classList.toggle('low', p.life <= 5);
  $('.hand-badge', mat).textContent = `Hand ${p.counts.hand}`;
  $('.hand-badge', mat).hidden = isMe;
  $('.mat-close', mat).hidden = isMe;

  const bf = $('.battlefield', mat);
  bf.dataset.empty = p.zones.battlefield.length ? '' : (isMe ? 'Your battlefield. Drag cards here.' : `${p.name}'s battlefield`);
  syncChildren(bf, p.zones.battlefield.map((c) => cardEl(c, 'battlefield', p, used)));

  const lib = $('.pile.library', mat);
  lib.classList.toggle('mine', isMe);
  $('.library-back', lib).style.visibility = p.counts.library ? 'visible' : 'hidden';
  $('.count', lib).textContent = p.counts.library;

  for (const z of ['graveyard', 'exile']) {
    const pile = $('.pile.' + z, mat);
    const list = p.zones[z];
    $('.count', pile).textContent = list.length || '';
    const slot = $('.slot', pile);
    slot.style.width = '100%';
    syncChildren(slot, list.length ? [cardEl(list[list.length - 1], z, p, used)] : []);
  }
}

function makeCardEl() {
  const el = document.createElement('div');
  el.className = 'card';
  el.innerHTML = '<span class="cname"></span><img alt="" draggable="false" loading="lazy">';
  // If an image fails, fall back to showing the card name.
  el.querySelector('img').onerror = function () { this.style.visibility = 'hidden'; };
  return el;
}

// Fill a card element from the card's view data.
function paintCard(el, c, zone, holder) {
  el.dataset.cardId = c.id;
  el.dataset.zone = zone;
  const hidden = !c.name || (zone === 'battlefield' && c.faceDown);
  el.classList.toggle('back', hidden);
  el.classList.toggle('facedown-peek', zone === 'battlefield' && !!c.faceDown && !!c.name);
  el.classList.toggle('tapped', zone === 'battlefield' && !!c.tapped);
  const img = el.querySelector('img');
  const src = c.transformed && c.back ? c.back : c.img;
  if (!hidden && src && img.getAttribute('src') !== src) img.src = src;
  if (!src) img.removeAttribute('src');
  img.style.visibility = src ? '' : 'hidden';
  el.querySelector('.cname').textContent = hidden ? '' : c.name || '';
  el.title = hidden ? 'Hidden card' : c.name;

  let ctr = el.querySelector('.ctr');
  if (zone === 'battlefield' && c.counters) {
    if (!ctr) { ctr = document.createElement('span'); ctr.className = 'ctr'; el.appendChild(ctr); }
    ctr.textContent = c.counters > 0 ? '+' + c.counters : c.counters;
  } else if (ctr) ctr.remove();

  // Coloured dot = someone else's card sitting on this playmat.
  let dot = el.querySelector('.owner-dot');
  const owner = playerById(c.owner);
  if (holder && owner && owner.id !== holder.id) {
    if (!dot) { dot = document.createElement('span'); dot.className = 'owner-dot'; el.appendChild(dot); }
    el.style.setProperty('--owner', owner.color);
    dot.title = `Owned by ${owner.name}`;
  } else if (dot) dot.remove();

  if (zone === 'battlefield') {
    el.style.left = (c.x * 100).toFixed(2) + '%';
    el.style.top = (c.y * 100).toFixed(2) + '%';
  } else {
    el.style.left = el.style.top = '';
  }
}

function cardEl(c, zone, holder, used) {
  let el = app.cardEls.get(c.id);
  if (!el) { el = makeCardEl(); app.cardEls.set(c.id, el); }
  used.add(c.id);
  paintCard(el, c, zone, holder);
  if (zone === 'battlefield') maybeAnimateArrival(el, c, holder);
  return el;
}

// Overlap hand cards so they always fit on one row.
function layoutHand() {
  const hand = $('#hand');
  const n = hand.children.length;
  if (!n) return;
  const cw = hand.children[0].getBoundingClientRect().width || 70;
  const avail = hand.clientWidth;
  const needed = n * (cw + 4);
  const overlap = needed > avail ? -Math.min(cw * 0.75, (needed - avail) / Math.max(1, n - 1) + 4) : 4;
  hand.style.setProperty('--overlap', overlap + 'px');
}
window.addEventListener('resize', layoutHand);

function renderLog() {
  if ($('#logPanel').hidden) return;
  const ol = $('#logList');
  ol.innerHTML = app.s.log.slice().reverse().map((l) => {
    const t = new Date(l.t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return `<li><span class="t">${t}</span>${esc(l.text)}</li>`;
  }).join('');
}

// ---------- Drag and drop (mouse + touch via pointer events) ----------
let drag = null;
const LONG_PRESS_MS = 480;

document.addEventListener('pointerdown', (e) => {
  if (e.button > 0) return;
  const cardNode = e.target.closest('.card[data-card-id]');
  const libNode = !cardNode && e.target.closest('.pile.library.mine');
  if (!cardNode && !libNode) return;
  const src = cardNode || libNode.querySelector('.library-back');
  const rect = src.getBoundingClientRect();
  drag = {
    src,
    node: cardNode || libNode,
    id: cardNode ? cardNode.dataset.cardId : 'LIBRARY_TOP',
    fromLibrary: !cardNode,
    pointerId: e.pointerId,
    sx: e.clientX, sy: e.clientY, x: e.clientX, y: e.clientY,
    offX: e.clientX - rect.left, offY: e.clientY - rect.top,
    w: src.offsetWidth, h: src.offsetHeight,
    started: false,
    long: false,
    samples: [{ x: e.clientX, y: e.clientY, t: performance.now() }],
  };
  drag.timer = setTimeout(() => {
    if (drag && !drag.started) { drag.long = true; const d = drag; drag = null; onLongPress(d); }
  }, LONG_PRESS_MS);
});

document.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.pointerId) {
    if (!drag && e.pointerType === 'mouse') hoverPreview(e);
    return;
  }
  drag.x = e.clientX; drag.y = e.clientY;
  const now = performance.now();
  drag.samples.push({ x: e.clientX, y: e.clientY, t: now });
  while (drag.samples.length > 2 && now - drag.samples[0].t > 100) drag.samples.shift();
  if (!drag.started) {
    if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 7) return;
    startDrag();
  }
  e.preventDefault();
  drag.ghost.style.left = e.clientX - drag.offX + 'px';
  drag.ghost.style.top = e.clientY - drag.offY + 'px';
  highlight(dropTargetAt(e.clientX, e.clientY));
}, { passive: false });

document.addEventListener('pointerup', (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const d = drag;
  drag = null;
  clearTimeout(d.timer);
  if (d.started) {
    d.samples.push({ x: e.clientX, y: e.clientY, t: performance.now() });
    if (!tryFlick(d)) finishDrag(d, e.clientX, e.clientY);
  } else onClick(d);
});
document.addEventListener('pointercancel', () => {
  if (!drag) return;
  clearTimeout(drag.timer);
  cleanupDrag(drag);
  drag = null;
});
document.addEventListener('contextmenu', (e) => {
  const cardNode = e.target.closest('.card[data-card-id]');
  if (!cardNode && !e.target.closest('.pile')) return;
  e.preventDefault();
  if (drag) { clearTimeout(drag.timer); cleanupDrag(drag); drag = null; }
  if (cardNode) openCardMenu(cardNode.dataset.cardId);
  else onPileClick(e.target.closest('.pile'));
});

function startDrag() {
  drag.started = true;
  clearTimeout(drag.timer);
  hidePreview();
  const ghost = drag.fromLibrary ? document.createElement('div') : drag.src.cloneNode(true);
  ghost.className = drag.fromLibrary ? 'card back ghost' : drag.src.className + ' ghost';
  ghost.classList.remove('tapped');
  ghost.style.width = drag.w + 'px';
  ghost.style.height = drag.h + 'px';
  document.body.appendChild(ghost);
  drag.ghost = ghost;
  drag.src.classList.add('dragging-src');
  // Dragging from inside a pile viewer: close the sheet so the table is reachable.
  if (drag.src.closest('#sheet')) closeSheet();
}

function dropTargetAt(x, y) {
  const el = document.elementFromPoint(x, y);
  return el && el.closest('[data-drop]');
}
let lastHl = null;
function highlight(t) {
  if (lastHl === t) return;
  if (lastHl) lastHl.classList.remove('drop-hover');
  lastHl = t;
  if (t) t.classList.add('drop-hover');
}
function cleanupDrag(d) {
  if (d.ghost) d.ghost.remove();
  d.src.classList.remove('dragging-src');
  highlight(null);
}

// ---------- Flick to send ----------
// A fast swipe that ends with the card still moving sends it to the player
// sitting in that direction (left, across or right).
const FLICK_SPEED = 0.9; // px per ms, measured over the last ~100ms before release
function tryFlick(d) {
  const a = d.samples[0];
  const b = d.samples[d.samples.length - 1];
  const dt = Math.max(1, b.t - a.t);
  const vx = (b.x - a.x) / dt;
  const vy = (b.y - a.y) / dt;
  const speed = Math.hypot(vx, vy);
  if (speed < FLICK_SPEED || b.t - a.t > 160) return false;
  // Don't treat a quick drop onto a specific zone (pile, hand, band) as a flick
  // A quick drop onto a pile or another player's band is a normal drop, not a flick.
  const target = dropTargetAt(b.x, b.y);
  if (target && !(target.dataset.player === app.s.you && ['battlefield', 'hand'].includes(target.dataset.zone))) return false;
  const dirs = { 1: [-1, 0], 2: [0, -1], 3: [1, 0] };
  let best = null;
  let bestDot = 0.55; // within roughly 55 degrees
  for (const rel of [1, 2, 3]) {
    const p = playerAtRel(rel);
    if (!p) continue;
    const dot = (vx * dirs[rel][0] + vy * dirs[rel][1]) / speed;
    if (dot > bestDot) { bestDot = dot; best = p; }
  }
  if (!best) return false;
  sendFlick(d, best, vx, vy);
  return true;
}

function sendFlick(d, to, vx, vy) {
  highlight(null);
  const g = d.ghost;
  const sp = Math.hypot(vx, vy);
  const dist = Math.max(innerWidth, innerHeight) * 1.2;
  const tx = (vx / sp) * dist;
  const ty = (vy / sp) * dist;
  d.src.style.visibility = 'hidden';
  const finish = () => {
    g.remove();
    d.src.classList.remove('dragging-src');
    d.src.style.visibility = '';
  };
  if (g.animate) {
    g.animate([{ transform: 'rotate(3deg) scale(1.05)' }, { transform: `translate(${tx}px, ${ty}px) rotate(${vx > 0 ? 40 : -40}deg) scale(0.9)` }],
      { duration: 380, easing: 'cubic-bezier(.3,.6,.4,1)', fill: 'forwards' }).onfinish = finish;
  } else finish();
  const spot = landingSpot(me(), to);
  send({ type: 'move', cardId: d.id, toPlayer: to.id, toZone: 'battlefield', x: spot.x, y: spot.y });
  toast(`Sent to ${to.name}`);
}

function finishDrag(d, x, y) {
  const target = dropTargetAt(x, y);
  cleanupDrag(d);
  if (!target) return;
  const toZone = target.dataset.zone;
  const toPlayer = target.dataset.player;
  const msg = { type: 'move', cardId: d.id, toPlayer, toZone };
  if (toZone === 'battlefield' && target.classList.contains('edge')) {
    // Dropped on another player's band: land it on their side facing you
    Object.assign(msg, landingSpot(me(), playerById(toPlayer)));
  } else if (toZone === 'battlefield') {
    const r = target.getBoundingClientRect();
    const mini = target.classList.contains('mini-bf');
    msg.x = Math.max(0, Math.min(0.94, (x - (mini ? 0 : d.offX) - r.left) / r.width));
    msg.y = Math.max(0, Math.min(0.9, (y - (mini ? 0 : d.offY) - r.top) / r.height));
    // Move it locally right away so it doesn't snap back while the server answers.
    const local = findCard(d.id);
    if (local && local.zone === 'battlefield' && local.player.id === toPlayer) {
      d.src.style.left = msg.x * 100 + '%';
      d.src.style.top = msg.y * 100 + '%';
      target.appendChild(d.src);
    }
  }
  if (toZone === 'hand' && target.id === 'handBar') {
    // Drop position inside my hand sets the order.
    const cards = [...$('#hand').children].filter((c) => c !== d.src);
    const idx = cards.findIndex((c) => { const r = c.getBoundingClientRect(); return x < r.left + r.width / 2; });
    msg.index = idx < 0 ? cards.length : idx;
  }
  send(msg);
}

function onClick(d) {
  if (d.fromLibrary) return send({ type: 'draw', n: 1 });
  const zone = d.node.dataset.zone;
  if (d.node.closest('.pile')) return onPileClick(d.node.closest('.pile'));
  if (d.node.closest('#sheet')) return openCardMenu(d.id);
  if (zone === 'battlefield') return send({ type: 'tap', cardId: d.id });
  openCardMenu(d.id);
}
function onLongPress(d) {
  if (navigator.vibrate) try { navigator.vibrate(15); } catch {}
  if (d.fromLibrary) return openLibraryMenu();
  if (d.node.closest('.pile') && !d.node.closest('#sheet')) return onPileClick(d.node.closest('.pile'));
  openCardMenu(d.id);
}

// Clicks on piles that aren't on a card (empty pile, library of others)
document.addEventListener('click', (e) => {
  const pile = e.target.closest('.pile');
  if (!pile || e.target.closest('.card') || pile.classList.contains('mine')) return;
  onPileClick(pile);
});
function onPileClick(pile) {
  const pid = pile.dataset.player;
  const zone = pile.dataset.zone;
  if (zone === 'library') {
    if (pid === app.s.you) openLibraryMenu();
    else toast(`${playerById(pid).name}'s library: ${playerById(pid).counts.library} cards`);
    return;
  }
  openPileSheet(pid, zone);
}

// ---------- Hover preview (desktop) ----------
function hoverPreview(e) {
  const c = e.target.closest && e.target.closest('.card[data-card-id]');
  const img = c && !c.classList.contains('back') && c.querySelector('img').getAttribute('src');
  if (!img || !matchMedia('(hover: hover) and (min-width: 601px)').matches) return hidePreview();
  const p = $('#preview');
  const pi = p.querySelector('img');
  if (pi.getAttribute('src') !== img) pi.src = img;
  p.style.left = e.clientX > innerWidth / 2 ? '14px' : '';
  p.style.right = e.clientX > innerWidth / 2 ? '' : '14px';
  p.hidden = false;
}
function hidePreview() { $('#preview').hidden = true; }

// ---------- Sheets ----------
let sheetKind = null;
let sheetData = null;
function openSheet(kind, html, data) {
  sheetKind = kind;
  sheetData = data || null;
  $('#sheet').innerHTML = html;
  $('#sheetWrap').hidden = false;
  hidePreview();
}
function closeSheet() {
  $('#sheetWrap').hidden = true;
  if (sheetKind === 'library') app.library = null;
  sheetKind = null;
  sheetData = null;
}
$('#sheetWrap').addEventListener('click', (e) => {
  if (e.target.id === 'sheetWrap' || e.target.closest('[data-close]')) closeSheet();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

function moveRows(cardId) {
  const order = [me(), ...app.s.players.filter((p) => p.id !== app.s.you).sort((a, b) => a.seat - b.seat)];
  return order.map((p) => `
    <div class="move-row" style="--seat:${p.color}">
      <div class="who"><span class="dot"></span>${esc(p.id === app.s.you ? 'You' : p.name)}</div>
      <div class="chips">
        ${['hand', 'battlefield', 'graveyard', 'exile'].map((z) => `<button class="chip" data-move="${z}" data-player="${p.id}">${ZONE_LABEL[z]}</button>`).join('')}
        <button class="chip" data-move="library" data-player="${p.id}">Library top</button>
        <button class="chip" data-move="library" data-bottom="1" data-player="${p.id}">Library bottom</button>
      </div>
    </div>`).join('');
}

function openCardMenu(cardId) {
  const found = findCard(cardId);
  if (!found) return;
  const { card: c, zone, player: holder } = found;
  const visible = !!c.name;
  const src = c.transformed && c.back ? c.back : c.img;
  const owner = playerById(c.owner);
  const bf = zone === 'battlefield';
  openSheet('card', `
    <button class="btn small sheet-close" data-close>Close</button>
    <div class="sheet-top">
      <div class="sheet-card ${visible ? '' : 'back'}">${visible && src ? `<img src="${esc(src)}" alt="${esc(c.name)}">` : ''}</div>
      <div style="flex:1;min-width:0">
        <h3>${visible ? esc(c.name) : 'Hidden card'}</h3>
        <div class="note">${ZONE_LABEL[zone]} of ${esc(holder.id === app.s.you ? 'you' : holder.name)}${owner && owner.id !== holder.id ? ` · owned by ${esc(owner.name)}` : ''}${bf && c.faceDown ? ' · face down' : ''}</div>
        ${bf ? `<div class="sheet-actions" style="margin-top:10px">
          <button class="btn small" data-op="tap">${c.tapped ? 'Untap' : 'Tap'}</button>
          ${c.back ? `<button class="btn small" data-op="flip">Transform</button>` : ''}
          <button class="btn small" data-op="faceDown">${c.faceDown ? 'Turn face up' : 'Turn face down'}</button>
          <button class="btn small" data-op="ctr+">+1 counter</button>
          <button class="btn small" data-op="ctr-">−1 counter</button>
        </div>` : ''}
        ${!bf && c.back && visible ? `<div class="sheet-actions" style="margin-top:10px"><button class="btn small" data-op="peekBack">Show back face</button></div>` : ''}
      </div>
    </div>
    <h3 style="margin-top:14px">Move to</h3>
    ${moveRows(cardId)}
  `, { cardId });
  const sheet = $('#sheet');
  sheet.querySelectorAll('[data-move]').forEach((b) => {
    b.onclick = () => {
      const msg = { type: 'move', cardId, toPlayer: b.dataset.player, toZone: b.dataset.move, bottom: !!b.dataset.bottom };
      send(msg);
      if (zone === 'library') { app.library = app.library.filter((x) => x.id !== cardId); return openLibrarySheet(true); }
      closeSheet();
    };
  });
  sheet.querySelectorAll('[data-op]').forEach((b) => {
    b.onclick = () => {
      const op = b.dataset.op;
      if (op === 'peekBack') { const im = $('.sheet-card img', sheet); im.src = im.src === c.back ? c.img : c.back; return; }
      if (op === 'ctr+' || op === 'ctr-') send({ type: 'counter', cardId, delta: op === 'ctr+' ? 1 : -1 });
      else send({ type: op, cardId });
      closeSheet();
    };
  });
}

function openLibraryMenu() {
  const m = me();
  openSheet('libmenu', `
    <button class="btn small sheet-close" data-close>Close</button>
    <h3>Your library (${m.counts.library} cards)</h3>
    <div class="sheet-actions">
      <button class="btn" data-l="draw1">Draw 1</button>
      <button class="btn" data-l="draw7">Draw 7</button>
      <button class="btn" data-l="shuffle">Shuffle</button>
      <button class="btn" data-l="mill">Mill 1</button>
      <button class="btn" data-l="search">Search library</button>
    </div>
    <p class="note">Tip: tap your library to draw, or drag it to put the top card anywhere.</p>`);
  $('#sheet').querySelectorAll('[data-l]').forEach((b) => {
    b.onclick = () => {
      const a = b.dataset.l;
      if (a === 'search') return openLibrarySheet();
      if (a === 'draw1') send({ type: 'draw', n: 1 });
      if (a === 'draw7') send({ type: 'draw', n: 7 });
      if (a === 'shuffle') send({ type: 'shuffle' });
      if (a === 'mill') send({ type: 'mill' });
      closeSheet();
    };
  });
}

function openLibrarySheet(quiet) {
  openSheet('library', `<p class="muted">Loading library…</p>`);
  if (app.library && quiet) renderLibrarySheet();
  send({ type: 'searchLibrary', quiet: !!quiet });
}
function renderLibrarySheet() {
  const sheet = $('#sheet');
  sheet.innerHTML = `
    <button class="btn small sheet-close" data-close>Done</button>
    <h3>Your library, top to bottom (${app.library.length})</h3>
    <p class="note">Only you can see this. Tap a card to move it, or drag it onto the table.</p>
    <div class="row"><button class="btn small" id="libShuffle">Shuffle and close</button></div>
    <div class="grid-cards"></div>`;
  const grid = $('.grid-cards', sheet);
  for (const c of app.library) {
    const el = makeCardEl();
    paintCard(el, c, 'library', null);
    grid.appendChild(el);
  }
  $('#libShuffle').onclick = () => { send({ type: 'shuffle' }); closeSheet(); };
}

function openPileSheet(pid, zone) {
  openSheet('pile', '', { pid, zone });
  renderPileSheet();
}
function renderPileSheet() {
  const { pid, zone } = sheetData;
  const p = playerById(pid);
  if (!p) return closeSheet();
  const list = p.zones[zone].slice().reverse();
  const sheet = $('#sheet');
  sheet.innerHTML = `
    <button class="btn small sheet-close" data-close>Close</button>
    <h3>${esc(p.id === app.s.you ? 'Your' : p.name + "'s")} ${zone} (${list.length})</h3>
    <p class="note">Newest first. Tap a card to move it, or drag it onto the table.</p>
    <div class="grid-cards">${list.length ? '' : '<p class="muted">Empty.</p>'}</div>`;
  const grid = $('.grid-cards', sheet);
  for (const c of list) {
    const el = makeCardEl();
    paintCard(el, c, zone, p);
    grid.appendChild(el);
  }
}

// ---------- Deck import ----------
const SAMPLE_DECK = `// Sample: mono-red aggro (60 cards)
4 Monastery Swiftspear
4 Goblin Guide
4 Bloodthirsty Adversary
4 Kumano Faces Kakkazan
4 Lightning Bolt
4 Play with Fire
4 Light Up the Stage
4 Skewer the Critics
4 Embercleave
2 Fable of the Mirror-Breaker
2 Delver of Secrets
20 Mountain`;

// ---------- Saved decks ----------
// GUESS: decks are saved on this device only (localStorage), with no accounts.
// Each deck keeps its pasted list plus the cards already matched on Scryfall,
// so bringing it to a table is instant and needs no lookups.
function loadDecks() {
  try { return JSON.parse(localStorage.getItem('ps:decks') || '[]').filter((d) => d && d.id && Array.isArray(d.cards)); } catch { return []; }
}
function storeDecks(decks) { localStorage.setItem('ps:decks', JSON.stringify(decks)); }
function deckById(id) { return loadDecks().find((d) => d.id === id) || null; }
function deckSize(d) { return d.cards.reduce((n, c) => n + (c.qty || 1), 0); }
function pickedDeckId() { try { return localStorage.getItem('ps:deckPick') || ''; } catch { return ''; } }
function setPickedDeck(id) { try { localStorage.setItem('ps:deckPick', id || ''); } catch {} }
function pickedDeck() { const id = pickedDeckId(); return id ? deckById(id) : null; }

// Same cards are stored once with a count, to keep storage small.
function packCards(cards) {
  const out = [];
  const byKey = new Map();
  for (const c of cards) {
    const key = [c.name, c.img, c.back, c.commander ? 1 : 0].join('|');
    const hit = byKey.get(key);
    if (hit) hit.qty++;
    else { const e = { name: c.name, img: c.img, back: c.back, commander: !!c.commander, qty: 1 }; byKey.set(key, e); out.push(e); }
  }
  return out;
}
function unpackCards(packed) {
  const out = [];
  for (const c of packed) for (let k = 0; k < (c.qty || 1); k++) out.push({ name: c.name, img: c.img, back: c.back, commander: c.commander });
  return out;
}

function guessDeckName(text, cards) {
  const cmdrs = [...new Set(cards.filter((c) => c.commander).map((c) => c.name))];
  if (cmdrs.length) return cmdrs.join(' & ');
  const first = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
  const m = first.match(/^(?:\/\/|#)\s*(?:name\s*:\s*)?(.+)$/i);
  if (m) return m[1].slice(0, 60);
  return 'Deck ' + (loadDecks().length + 1);
}

// Returns the saved deck, or throws if the device has no room left.
function saveDeck({ id, name, text, cards }) {
  const decks = loadDecks();
  const deck = { id: id || 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: name.slice(0, 60), text, cards: packCards(cards), updated: Date.now() };
  const i = decks.findIndex((d) => d.id === deck.id);
  if (i >= 0) decks[i] = deck; else decks.push(deck);
  storeDecks(decks);
  return deck;
}
function deleteDeck(id) {
  storeDecks(loadDecks().filter((d) => d.id !== id));
  if (pickedDeckId() === id) setPickedDeck('');
}

function renderLandingDecks() {
  const list = $('#deckList');
  const decks = loadDecks();
  let pick = pickedDeckId();
  if (pick && !decks.some((d) => d.id === pick)) pick = '';
  const row = (d) => `
    <label class="deck-row">
      <input type="radio" name="deckPick" value="${esc(d.id)}" ${pick === d.id ? 'checked' : ''}>
      <span class="deck-name">${esc(d.name)}</span>
      <span class="deck-count">${deckSize(d)} cards</span>
      <button class="btn small" data-deck-edit="${esc(d.id)}">Edit</button>
      <button class="btn small danger" data-deck-del="${esc(d.id)}">Delete</button>
    </label>`;
  list.innerHTML = decks.length
    ? decks.map(row).join('') + `
      <label class="deck-row">
        <input type="radio" name="deckPick" value="" ${pick ? '' : 'checked'}>
        <span class="deck-name muted">No deck, I'll load one at the table</span>
      </label>`
    : '<p class="note">No saved decks yet. Import one now so it is ready when you sit down.</p>';
}
$('#deckList').addEventListener('change', (e) => { if (e.target.name === 'deckPick') setPickedDeck(e.target.value); });
$('#deckList').addEventListener('click', (e) => {
  const edit = e.target.closest('[data-deck-edit]');
  const del = e.target.closest('[data-deck-del]');
  if (!edit && !del) return;
  e.preventDefault(); // don't also pick the row
  if (edit) return openDeckSheet({ mode: 'landing', editId: edit.dataset.deckEdit });
  if (del.dataset.armed) { deleteDeck(del.dataset.deckDel); return renderLandingDecks(); }
  del.dataset.armed = '1';
  del.textContent = 'Tap again to delete';
  setTimeout(() => { if (del.isConnected) { delete del.dataset.armed; del.textContent = 'Delete'; } }, 3000);
});
$('#addDeckBtn').onclick = () => openDeckSheet({ mode: 'landing' });

// Right after sitting down: shuffle in the deck picked on the landing page,
// unless this seat already has cards (rejoining a game in progress).
function bringPendingDeck() {
  const deck = app.pendingDeck;
  const m = me();
  if (!m) return;
  app.pendingDeck = null;
  const owned = Object.values(m.counts || {}).reduce((a, b) => a + b, 0);
  if (owned > 0) return;
  send({ type: 'loadDeck', cards: unpackCards(deck.cards) });
  toast(`${deck.name} is shuffled into your library. Tap your library to draw.`);
}

function loadSavedDeck(id) {
  const deck = deckById(id);
  if (!deck) return;
  setPickedDeck(deck.id);
  send({ type: 'loadDeck', cards: unpackCards(deck.cards) });
  closeSheet();
  toast(`Loaded ${deck.name} (${deckSize(deck)} cards) and shuffled. Tap your library to draw.`);
}

// mode 'game': load onto the table (and optionally save). mode 'landing': save only.
function openDeckSheet(opts = {}) {
  const mode = opts.mode || 'game';
  const editing = opts.editId ? deckById(opts.editId) : null;
  const decks = mode === 'game' ? loadDecks() : [];
  let saved = '';
  if (editing) saved = editing.text;
  else if (mode === 'game') { try { saved = localStorage.getItem('ps:deck') || ''; } catch {} }
  const savedRows = decks.map((d) => `
    <div class="deck-row">
      <span class="deck-name">${esc(d.name)}</span>
      <span class="deck-count">${deckSize(d)} cards</span>
      <button class="btn small primary" data-deck-load="${esc(d.id)}">Load</button>
    </div>`).join('');
  openSheet('deck', `
    <button class="btn small sheet-close" data-close>Close</button>
    <h3>${editing ? 'Edit deck' : mode === 'landing' ? 'Import a deck' : 'Load a deck'}</h3>
    ${decks.length ? `<p class="note">Your saved decks</p><div class="deck-list" style="margin:6px 0 4px">${savedRows}</div><h4>Or import a new one</h4>` : ''}
    <label class="field">Deck name
      <input id="deckName" maxlength="60" placeholder="Optional, e.g. Mono-red aggro" value="${esc(editing ? editing.name : '')}">
    </label>
    <p class="note">Paste a public Moxfield deck link, or a deck list with one card per line, like <code>4 Lightning Bolt</code>. Export from Moxfield, Archidekt, MTG Arena, MTGO and most other deckbuilders works ("Export → Text"). Lines under a <code>Sideboard</code> heading are skipped. Cards under a <code>Commander</code> heading start on your battlefield.</p>
    <textarea id="deckText" spellcheck="false" placeholder="https://moxfield.com/decks/…&#10;or&#10;4 Lightning Bolt&#10;20 Mountain">${esc(saved)}</textarea>
    <div class="row">
      <button class="btn primary" id="deckLoad">${mode === 'landing' ? 'Save deck' : 'Load deck'}</button>
      <button class="btn" id="deckSample">Use sample deck</button>
      ${mode === 'game' ? '<label class="check"><input type="checkbox" id="deckSave" checked> Save to my decks</label>' : ''}
      <span id="deckStatus" class="note"></span>
    </div>
    <div class="guess">${mode === 'landing'
      ? 'Saved decks stay on this device, in this browser. Cards are matched on Scryfall once, when you save.'
      : 'Loading a deck replaces all of your current cards, wherever they are on the table, and shuffles them into your library.'} Moxfield links work for public decks. For other deckbuilders, paste the exported list.</div>`,
  { mode, editId: editing ? editing.id : null });
  $('#deckSample').onclick = () => { $('#deckText').value = SAMPLE_DECK; };
  $('#deckLoad').onclick = () => importDeck($('#deckText').value);
  $('#sheet').querySelectorAll('[data-deck-load]').forEach((b) => { b.onclick = () => loadSavedDeck(b.dataset.deckLoad); });
}

// After the Scryfall lookup: save the deck and/or put it on the table, as the sheet asks.
function finishImport(text, cards, notFound) {
  const status = $('#deckStatus');
  if (!cards.length) return (status.textContent = 'None of those cards were found on Scryfall.');
  const opts = sheetData || { mode: 'game' };
  const name = $('#deckName').value.trim() || guessDeckName(text, cards);
  const wantSave = opts.mode === 'landing' || ($('#deckSave') && $('#deckSave').checked);
  let deck = null;
  let saveErr = '';
  if (wantSave) {
    try { deck = saveDeck({ id: opts.editId, name, text, cards }); } catch { saveErr = ' This device has no room left to save it.'; }
  }
  const missed = notFound.length ? ` Not found: ${notFound.join(', ')}` : '';
  if (opts.mode === 'landing') {
    if (deck) setPickedDeck(deck.id);
    renderLandingDecks();
    if (!deck) return (status.textContent = 'Could not save the deck.' + saveErr);
    if (missed) return (status.textContent = `Saved ${name} (${cards.length} cards).${missed}`);
    closeSheet();
    return;
  }
  if (deck) setPickedDeck(deck.id);
  send({ type: 'loadDeck', cards });
  if (missed || saveErr) {
    status.textContent = `Loaded ${cards.length} cards.${saveErr}${missed}`;
  } else {
    closeSheet();
    toast(`Loaded ${cards.length} cards${deck ? ', saved to your decks,' : ''} and shuffled. Tap your library to draw.`);
  }
}

// Parse common deck list formats into [{qty, name, set, num, commander}]
function parseDeck(text) {
  const out = [];
  let section = 'main';
  for (let raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('#')) continue;
    const head = line.toLowerCase().replace(/[:\s]+$/, '');
    if (['sideboard', 'maybeboard', 'considering', 'tokens'].includes(head)) { section = 'side'; continue; }
    if (['commander', 'commanders'].includes(head)) { section = 'commander'; continue; }
    if (['deck', 'main', 'mainboard', 'main deck', 'companion'].includes(head)) { section = 'main'; continue; }
    if (/^sb:\s*/i.test(line)) continue; // MTGO style sideboard line
    if (section === 'side') continue;
    const m = line.match(/^(\d+)\s*x?\s+(.+)$/i);
    let qty = 1, rest = line;
    if (m) { qty = Math.min(99, parseInt(m[1], 10)); rest = m[2]; }
    let commander = section === 'commander';
    if (/\*CMDR\*/i.test(rest)) { commander = true; rest = rest.replace(/\*CMDR\*/ig, ''); }
    rest = rest.replace(/\s+\*[A-Z]\*\s*$/, '').replace(/\s+#.*$/, '').replace(/\s+\[[^\]]*\]\s*$/, '');
    let set = null, num = null;
    const sm = rest.match(/^(.*?)\s+\(([A-Za-z0-9]{2,6})\)\s*([A-Za-z0-9\-★]+)?\s*$/);
    if (sm) { rest = sm[1]; set = sm[2].toLowerCase(); num = sm[3] || null; }
    const name = rest.trim();
    if (name) out.push({ qty, name, set, num, commander });
  }
  return out;
}

function imagesOf(card) {
  if (card.image_uris) return { img: card.image_uris.normal, back: '' };
  if (card.card_faces && card.card_faces[0].image_uris) {
    return { img: card.card_faces[0].image_uris.normal, back: card.card_faces[1] && card.card_faces[1].image_uris ? card.card_faces[1].image_uris.normal : '' };
  }
  return { img: '', back: '' };
}

async function scryfallCollection(identifiers) {
  const res = await fetch('https://api.scryfall.com/cards/collection', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ identifiers }),
  });
  if (!res.ok) throw new Error('Scryfall returned ' + res.status);
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();

// Every name a deckbuilder might use for this printing: the real name, each face,
// and alternate printed names such as Godzilla series names ("flavor names").
function namesOf(card) {
  const out = [card.name, card.flavor_name, card.printed_name];
  for (const f of card.card_faces || []) out.push(f.name, f.flavor_name, f.printed_name);
  return out.filter(Boolean).map(norm);
}
function cardMatches(card, wanted) {
  const w = norm(wanted);
  return namesOf(card).includes(w) || norm(card.name).startsWith(w.split(' // ')[0] + ' //');
}

// Last resort for one name: Scryfall search across all printings, keeping only
// a result whose real or alternate name matches exactly.
async function scryfallLookupOne(name) {
  const queries = [
    `!"${name.replace(/"/g, '')}" unique:prints include:extras`,
    `"${name.replace(/"/g, '')}" unique:prints include:extras`,
  ];
  for (const q of queries) {
    const res = await fetch('https://api.scryfall.com/cards/search?q=' + encodeURIComponent(q), { headers: { Accept: 'application/json' } });
    await sleep(120);
    if (res.status === 404) continue;
    if (!res.ok) throw new Error('Scryfall returned ' + res.status);
    const data = await res.json();
    const hit = (data.data || []).find((c) => cardMatches(c, name));
    if (hit) return hit;
  }
  const res = await fetch('https://api.scryfall.com/cards/named?fuzzy=' + encodeURIComponent(name), { headers: { Accept: 'application/json' } });
  await sleep(120);
  if (res.ok) {
    const c = await res.json();
    if (cardMatches(c, name)) return c;
  }
  return null;
}

// A pasted Moxfield deck link, e.g. https://www.moxfield.com/decks/AbC123xyz
function moxfieldId(text) {
  const m = String(text).trim().match(/^(?:https?:\/\/)?(?:www\.)?moxfield\.com\/decks\/([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/i);
  return m ? m[1] : null;
}

// The server fetches the deck (Moxfield can't be called from the browser) and
// returns it as a plain text list.
async function fetchMoxfieldDeck(id) {
  const res = await fetch('/api/moxfield/' + encodeURIComponent(id), { headers: { Accept: 'application/json' } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Could not load that Moxfield deck.');
  return data;
}

async function importDeck(text) {
  const status = $('#deckStatus');
  // Keep what the player pasted (the link) as the deck's saved text.
  const pasted = text.trim();
  try { localStorage.setItem('ps:deck', pasted); } catch {}
  const mox = moxfieldId(pasted);
  if (mox) {
    $('#deckLoad').disabled = true;
    status.textContent = 'Getting the deck from Moxfield…';
    try {
      const deck = await fetchMoxfieldDeck(mox);
      text = deck.text;
      if (deck.name && $('#deckName') && !$('#deckName').value.trim()) $('#deckName').value = deck.name;
    } catch (err) {
      $('#deckLoad').disabled = false;
      status.textContent = err.message;
      return;
    }
  }
  const entries = parseDeck(text);
  if (!entries.length) { $('#deckLoad').disabled = false; return (status.textContent = 'No cards found in that list.'); }
  $('#deckLoad').disabled = true;
  status.textContent = 'Looking up cards on Scryfall…';
  const resolved = new Map(); // entry index -> scryfall card
  try {
    // Pass 1: exact printing when the list gives set + collector number, otherwise by name.
    // Scryfall accepts up to 75 identifiers per request.
    for (let i = 0; i < entries.length; i += 75) {
      const chunk = entries.slice(i, i + 75);
      const ids = chunk.map((e) => (e.set && e.num ? { set: e.set, collector_number: e.num } : { name: e.name.split(' // ')[0] }));
      const data = await scryfallCollection(ids);
      const found = data.data || [];
      chunk.forEach((e, j) => {
        const want = ids[j];
        const card = want.name
          ? found.find((c) => cardMatches(c, want.name) || cardMatches(c, e.name))
          : found.find((c) => c.set === want.set && String(c.collector_number).toLowerCase() === String(want.collector_number).toLowerCase());
        if (card) resolved.set(i + j, card);
      });
      if (i + 75 < entries.length) await sleep(550);
    }
    // Pass 2: anything still missing, by name (e.g. a set code Scryfall doesn't know).
    const missing = entries.map((e, i) => [e, i]).filter(([, i]) => !resolved.has(i));
    for (let i = 0; i < missing.length; i += 75) {
      const chunk = missing.slice(i, i + 75);
      await sleep(550);
      const data = await scryfallCollection(chunk.map(([e]) => ({ name: e.name.split(' // ')[0] })));
      for (const [e, idx] of chunk) {
        const card = (data.data || []).find((c) => cardMatches(c, e.name));
        if (card) resolved.set(idx, card);
      }
    }
    // Pass 3: alternate names (Godzilla series and similar) need a search, one by one.
    const still = entries.map((e, i) => [e, i]).filter(([, i]) => !resolved.has(i));
    for (const [n, [e, idx]] of still.entries()) {
      status.textContent = `Looking up alternate names… (${n + 1} of ${still.length})`;
      const card = await scryfallLookupOne(e.name);
      if (card) resolved.set(idx, card);
    }
  } catch (err) {
    $('#deckLoad').disabled = false;
    status.textContent = 'Could not reach Scryfall (' + err.message + '). Check your connection and try again.';
    return;
  }
  const notFound = [];
  const cards = [];
  entries.forEach((e, i) => {
    const sc = resolved.get(i);
    if (!sc) return notFound.push(e.name);
    const im = imagesOf(sc);
    // Keep the name the player knows it by, with the real name alongside when they differ.
    const alt = norm(e.name) !== norm(sc.name) && !norm(sc.name).startsWith(norm(e.name) + ' //');
    const name = alt ? `${e.name} (${sc.name})` : sc.name;
    for (let k = 0; k < e.qty; k++) cards.push({ name, img: im.img, back: im.back, commander: e.commander });
  });
  $('#deckLoad').disabled = false;
  finishImport(mox ? pasted : text, cards, notFound);
}

// ---------- Top bar ----------
$('#game').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const a = b.dataset.act;
  if (a === 'deck') openDeckSheet();
  if (a === 'draw') send({ type: 'draw', n: 1 });
  if (a === 'untap') send({ type: 'untapAll' });
  if (a === 'shuffle') send({ type: 'shuffle' });
  if (a === 'log') { $('#logPanel').hidden = !$('#logPanel').hidden; renderLog(); }
  if (a === 'more') openMoreMenu();
});

$('#inviteBtn').onclick = async () => {
  const url = `${location.origin}/s/${app.code}`;
  try {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) await navigator.share({ title: 'Join my Planar Bridge table', url });
    else { await navigator.clipboard.writeText(url); toast('Invite link copied'); }
  } catch { toast(`Share this link: ${url}`); }
};

function openMoreMenu() {
  const m = me();
  openSheet('more', `
    <button class="btn small sheet-close" data-close>Close</button>
    <h3>Session ${esc(app.code)}</h3>
    <p class="note">Invite link: <code>${esc(location.origin)}/s/${esc(app.code)}</code> · ${app.s.players.length} of 4 seats taken</p>
    <div class="sheet-actions" style="margin-top:12px">
      <button class="btn primary" data-m="deck">Load deck</button>
      <button class="btn" data-m="fullscreen">${document.fullscreenElement || document.webkitFullscreenElement ? 'Exit full screen' : 'Full screen'}</button>
      <button class="btn" data-m="seating">Seating</button>
      <button class="btn" data-m="log">Game log</button>
      <button class="btn" data-m="untap">Untap all</button>
      <button class="btn" data-m="shuffle">Shuffle library</button>
      <button class="btn" data-m="new">Reset my cards (new game)</button>
      <button class="btn" data-m="rename">Change my name</button>
      <button class="btn danger" data-m="leave">Leave session</button>
    </div>
    <div id="moreExtra"></div>
    <h3 style="margin-top:14px">How to play here</h3>
    <ul class="note">
      <li>Flick a card toward another player to send it across to their tablet. Each edge of your screen faces the player sitting on that side (set this up under Seating).</li>
      <li>You can also drag a card onto a player's edge band, or tap or long-press a card for a menu with every move.</li>
      <li>Tap a player's edge band to see their playmat. Tap Close to put it away.</li>
      <li>Tap the Hand tab to tuck your hand away and use the whole screen.</li>
      <li>Click or tap a card on the battlefield to tap / untap it. Right-click or long-press for more.</li>
      <li>Tap your library to draw. Drag it to move the top card somewhere.</li>
      <li>Anyone can change anyone's life total with − and +.</li>
      <li>A coloured dot on a card means it belongs to the player of that colour.</li>
    </ul>`);
  $('#sheet').querySelectorAll('[data-m]').forEach((b) => {
    b.onclick = () => {
      const a = b.dataset.m;
      const extra = $('#moreExtra');
      if (a === 'deck') return openDeckSheet();
      if (a === 'seating') return openSeatingSheet();
      if (a === 'log') { closeSheet(); $('#logPanel').hidden = false; return renderLog(); }
      if (a === 'fullscreen') { toggleFullscreen(); return closeSheet(); }
      if (a === 'untap') { send({ type: 'untapAll' }); closeSheet(); }
      if (a === 'shuffle') { send({ type: 'shuffle' }); closeSheet(); }
      if (a === 'new') {
        extra.innerHTML = `<div class="guess">This puts every card you own back into your library, shuffles, and sets your life to ${app.s.startingLife}. <button class="btn small" id="cNew">Yes, reset</button></div>`;
        $('#cNew').onclick = () => { send({ type: 'newGame' }); closeSheet(); };
      }
      if (a === 'rename') {
        extra.innerHTML = `<div class="row"><input id="rn" class="field" style="font-size:16px;padding:8px;border-radius:8px;background:#11141a;color:inherit;border:1px solid var(--line)" maxlength="24" value="${esc(m.name)}"><button class="btn small" id="rnOk">Save</button></div>`;
        $('#rnOk').onclick = () => { send({ type: 'rename', name: $('#rn').value }); rememberName($('#rn').value); closeSheet(); };
      }
      if (a === 'leave') {
        extra.innerHTML = `<div class="guess">Leaving removes your cards from the table and frees your seat. <button class="btn small danger" id="cLeave">Leave</button></div>`;
        $('#cLeave').onclick = () => send({ type: 'leave' });
      }
    };
  });
}

boot();

// ---------- Reliable taps on touch screens ----------
// Some tablets drop the "click" that should follow a tap, especially right
// after a drag. For touch input we fire the click ourselves on pointerup and
// swallow the browser's own click if it arrives too.
(() => {
  const TAPPABLE = 'button, .edge, .pile:not(.mine), .chip';
  let down = null;
  let synth = false;
  let swallowUntil = 0;
  let synthAt = 0;
  let lastDown = { target: null, t: 0 };
  document.addEventListener('pointerdown', (e) => {
    lastDown = { target: e.target, t: performance.now() };
    if (e.pointerType === 'mouse') return;
    const el = e.target.closest(TAPPABLE);
    if (!el || e.target.closest('.card[data-card-id]')) return (down = null);
    down = { el, target: e.target, x: e.clientX, y: e.clientY, id: e.pointerId };
  }, true);
  document.addEventListener('pointerup', (e) => {
    const d = down;
    down = null;
    if (!d || e.pointerId !== d.id || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 12) return;
    if (!d.el.isConnected || d.el.disabled) return;
    swallowUntil = Date.now() + 700;
    synthAt = performance.now();
    synth = true;
    try { d.target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); } finally { synth = false; }
  }, true);
  document.addEventListener('pointercancel', () => { down = null; }, true);
  document.addEventListener('click', (e) => {
    if (synth || Date.now() >= swallowUntil || e.pointerType === 'mouse') return;
    // A new press since our synthetic click means this is a genuine new click.
    const t = lastDown.target;
    if (lastDown.t > synthAt && t && (t === e.target || t.contains(e.target) || e.target.contains(t))) return;
    e.stopImmediatePropagation();
    e.preventDefault();
  }, true);
})();


// ---------- Full screen, hand drawer, my life ----------
function toggleFullscreen() {
  const d = document;
  const el = d.documentElement;
  try {
    if (d.fullscreenElement || d.webkitFullscreenElement) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
    else if (el.requestFullscreen) el.requestFullscreen({ navigationUI: 'hide' }).catch(() => fullscreenHelp());
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    else fullscreenHelp();
  } catch { fullscreenHelp(); }
}
function fullscreenHelp() {
  toast('For full screen on iPad: Share → Add to Home Screen, then open Planar Bridge from the home screen.');
}

$('#handTab').addEventListener('click', () => {
  $('#game').classList.toggle('hand-hidden');
  setTimeout(layoutHand, 260);
});
document.querySelectorAll('[data-mylife]').forEach((b) => {
  b.addEventListener('click', () => send({ type: 'life', playerId: app.s.you, delta: Number(b.dataset.mylife) }));
});

// ---------- Seating ----------
function openSeatingSheet() {
  openSheet('seating', '');
  renderSeatingSheet();
}
function renderSeatingSheet() {
  const m = me();
  const others = app.s.players.filter((p) => p !== m);
  $('#sheet').innerHTML = `
    <button class="btn small sheet-close" data-close>Done</button>
    <h3>Seating</h3>
    <p class="note">Tell Planar Bridge where everyone sits around the table, as seen from your seat. Flicking a card toward an edge sends it to the player on that side. Changes apply to every tablet.</p>
    ${others.length ? others.map((p) => `
      <div class="move-row" style="--seat:${p.color}">
        <div class="who"><span class="dot"></span>${esc(p.name)}</div>
        <div class="chips">${[1, 2, 3].map((rel) => `<button class="chip${relOf(p, m) === rel ? ' on' : ''}" data-seat="${p.id}" data-rel="${rel}">${{ 1: 'On my left', 2: 'Across from me', 3: 'On my right' }[rel]}</button>`).join('')}</div>
      </div>`).join('') : '<p class="muted">Nobody else has joined yet.</p>'}`;
  $('#sheet').querySelectorAll('[data-seat]').forEach((b) => {
    b.onclick = () => send({ type: 'seat', playerId: b.dataset.seat, pos: (m.pos + Number(b.dataset.rel)) % 4 });
  });
}
