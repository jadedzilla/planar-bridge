// Planar Bridge prototype client (no build step, no framework).
'use strict';

const $ = (sel, el = document) => el.querySelector(sel);
const ZONE_LABEL = { library: 'Library', hand: 'Hand', battlefield: 'Battlefield', graveyard: 'Graveyard', exile: 'Exile', command: 'Command zone' };
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
  shuffleSeen: new Map(), // player id -> shuffle count last shown
  settled: new Map(), // card id -> time it was dropped by hand here (no glide)
  drops: new Map(), // card id -> where it was let go, until the table catches up
  lastLife: null,
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
    app.matChecked = false;
    try { localStorage.setItem('ps:' + msg.code, msg.playerId); } catch {}
    history.replaceState(null, '', '/s/' + msg.code);
    $('#landing').hidden = true;
    $('#game').hidden = false;
    $('#codeLabel').textContent = msg.code;
  } else if (msg.type === 'state') {
    app.s = msg.state;
    render();
    preloadTableImages();
    if (app.pendingDeck) bringPendingDeck();
    bringSavedPlaymat();
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
  fillDeckColors();
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
    for (const z of ['hand', 'battlefield', 'graveyard', 'exile', 'command']) {
      const c = (p.zones[z] || []).find((x) => x.id === id);
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
  const before = snapshotCards();

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

  // My playmat (in the table view it sits in its seat with everyone else's)
  const myMat = matFor(mine);
  if (app.tableView) {
    syncChildren($('#myArea'), []);
    renderTableView(used);
  } else {
    syncChildren($('#myArea'), [myMat]);
    for (const cell of document.querySelectorAll('.tv-cell')) syncChildren(cell, []);
  }
  updateMat(myMat, mine, used);
  $('#myLife').textContent = mine.life;
  $('#myLife').classList.toggle('low', mine.life <= 5);
  if (app.lastLife != null && app.lastLife !== mine.life) replay($('#myDie'), 'roll');
  app.lastLife = mine.life;
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
  glideCards(before, mine);

  renderLog();
  if (sheetKind === 'pile') renderPileSheet();
  if (sheetKind === 'seating') renderSeatingSheet();
}

// ---------- Table view ----------
// Every playmat at once, laid out like the table seen from above: you in the
// bottom-left seat, then clockwise the player on your left, the one across
// (diagonally opposite) and the one on your right. Each mat is laid out at
// exactly the size of your own full-screen mat and then shrunk to fit its seat,
// so opening the view is just the camera pulling back from your mat, and
// closing it pushes back in to the very same picture.
const TV_SEATS = [1, 2, 0, 3]; // grid order: top-left, top-right, bottom-left, bottom-right
function renderTableView(used) {
  const cells = document.querySelectorAll('.tv-cell');
  TV_SEATS.forEach((rel, i) => {
    const cell = cells[i];
    const p = rel === 0 ? me() : playerAtRel(rel);
    if (!cell.firstElementChild) {
      cell.innerHTML = `<div class="tv-label"><span class="dot"></span><b class="nm"></b><span class="tv-sub"></span>
        <span class="tv-life"><button data-tvlife="-1" aria-label="Lose 1 life">−</button><span class="val"></span><button data-tvlife="1" aria-label="Gain 1 life">+</button></span></div>
        <div class="tv-frame"><div class="tv-stage my-area"></div><div class="tv-empty">Empty seat</div></div>`;
      cell.querySelectorAll('[data-tvlife]').forEach((btn) => {
        btn.onclick = () => cell.dataset.player && send({ type: 'life', playerId: cell.dataset.player, delta: Number(btn.dataset.tvlife) });
      });
    }
    cell.classList.toggle('empty', !p);
    cell.classList.toggle('mine', rel === 0);
    const stage = $('.tv-stage', cell);
    if (!p) {
      delete cell.dataset.player;
      cell.style.removeProperty('--seat');
      syncChildren(stage, []);
      return;
    }
    cell.dataset.player = p.id;
    cell.style.setProperty('--seat', p.color);
    $('.nm', cell).textContent = p.name;
    $('.tv-sub', cell).textContent = rel === 0 ? '(you)' : `Hand ${p.counts.hand}` + (p.connected ? '' : ' · offline');
    const lv = $('.tv-life .val', cell);
    lv.textContent = p.life;
    lv.classList.toggle('low', p.life <= 5);
    const mat = matFor(p);
    syncChildren(stage, [mat]);
    if (p !== me()) updateMat(mat, p, used);
  });
  layoutTableView();
}

// Size every stage like the full-screen table, then scale it down so the cloth
// of the playmat fills its seat (the empty margins around it are cropped).
function layoutTableView() {
  if (!app.tableView) return;
  const table = $('#table');
  const W = table.clientWidth, H = table.clientHeight;
  const frames = document.querySelectorAll('.tv-frame');
  frames.forEach((f) => {
    const stage = $('.tv-stage', f);
    stage.style.width = W + 'px';
    stage.style.height = H + 'px';
  });
  // Where the cloth sits inside a full-size mat (the same for every mat)
  const body = $('.mat-body', matFor(me()));
  const cs = getComputedStyle(body, '::before');
  const cx = parseFloat(cs.left) || 0, cy = parseFloat(cs.top) || 0;
  const cw = W - cx - (parseFloat(cs.right) || 0), ch = H - cy - (parseFloat(cs.bottom) || 0);
  const f0 = frames[0];
  const k = Math.min(f0.clientWidth / cw, f0.clientHeight / ch) * 0.96; // room for its shadow
  app.tvK = k;
  frames.forEach((f) => {
    const stage = $('.tv-stage', f);
    stage.style.left = (f.clientWidth - cw * k) / 2 - cx * k + 'px';
    stage.style.top = (f.clientHeight - ch * k) / 2 - cy * k + 'px';
    stage.style.transform = `scale(${k})`;
  });
}
window.addEventListener('resize', () => app.tableView && !tvAnim && render());

// How much a card's spot on screen is shrunk (mats in the table view are scaled down).
function zoomOf(el) {
  return app.tableView && el && el.closest && el.closest('.tv-stage') ? app.tvK || 1 : 1;
}

let tvAnim = null;
function setTableView(on) {
  if (tvAnim || !app.s || on === !!app.tableView) return;
  const game = $('#game');
  const grid = $('.tv-grid');
  const myMat = matFor(me());
  const still = reduceMotion.matches || !grid.animate;
  const fade = (from, to, ms) => !still && document.querySelectorAll('.tv-label, .tv-back').forEach((el) => el.animate([{ opacity: from }, { opacity: to }], { duration: ms, easing: 'ease', fill: 'both' }));
  if (on) {
    app.focus = null;
    closeSheet();
    const full = $('#myArea').getBoundingClientRect();
    app.tableView = true;
    game.classList.add('table-mode');
    $('#tableView').hidden = false;
    app.tvSwitching = true;
    render();
    app.tvSwitching = false;
    if (still) return;
    const zoom = zoomOnto(grid, myMat.parentElement.getBoundingClientRect(), full);
    tvAnim = grid.animate([{ transform: zoom }, { transform: 'none' }], { duration: 750, easing: 'cubic-bezier(.45,0,.15,1)' });
    fade(0, 1, 750);
    tvAnim.onfinish = tvAnim.oncancel = () => { tvAnim = null; };
  } else {
    const done = () => {
      app.tableView = false;
      game.classList.remove('table-mode', 'table-leaving');
      $('#tableView').hidden = true;
      app.tvSwitching = true;
      render();
      app.tvSwitching = false;
      grid.getAnimations().forEach((x) => x.cancel());
      document.querySelectorAll('.tv-label, .tv-back').forEach((el) => el.getAnimations().forEach((x) => x.cancel()));
      tvAnim = null;
    };
    if (still) return done();
    game.classList.add('table-leaving');
    const zoom = zoomOnto(grid, myMat.parentElement.getBoundingClientRect(), $('#myArea').getBoundingClientRect());
    tvAnim = grid.animate([{ transform: 'none' }, { transform: zoom }], { duration: 650, easing: 'cubic-bezier(.45,0,.15,1)', fill: 'forwards' });
    fade(1, 0, 450);
    tvAnim.onfinish = done;
  }
}

// The transform that makes the rect `at` (inside el) cover the rect `to`.
function zoomOnto(el, at, to) {
  const g = el.getBoundingClientRect();
  const s = to.width / at.width;
  const tx = to.left - g.left - s * (at.left - g.left);
  const ty = to.top - g.top - s * (at.top - g.top);
  return `translate(${tx}px, ${ty}px) scale(${s})`;
}

function matFor(p) {
  let mat = app.matEls.get(p.id);
  if (!mat) { mat = createMat(p); app.matEls.set(p.id, mat); }
  return mat;
}

// Opening another player's playmat turns their band into it: the band slides
// out of its spot and stretches to the size of the playmat, carrying the board
// with it as the band's colour and label fade away. The band's
// spot stays empty while its board is open. Closing plays the same motion
// backwards, shrinking the board back into the band.
let focusAnim = null;
function setFocus(id) {
  if (focusAnim) return;
  const prev = app.focus;
  const next = prev === id ? null : id;
  if (prev) {
    playFocus(prev, false, () => { app.focus = next; render(); if (next) playFocus(next, true); });
    return;
  }
  app.focus = next;
  render();
  if (next) playFocus(next, true);
}

function playFocus(id, opening, done) {
  const area = $('#focusArea');
  const mat = area.firstElementChild;
  const p = playerById(id);
  const band = p && $(`.edge[data-player="${p.id}"]`);
  if (reduceMotion.matches || !mat || !band || !area.animate) { done && done(); return; }
  const rel = relOf(p);
  const F = area.getBoundingClientRect();
  const E = band.getBoundingClientRect();
  const bs = getComputedStyle(band);
  const out = -60; // past the playmat's edge, so its shadow isn't cut off
  // Clip that matches the band exactly (insets may reach outside the playmat)
  const px = (v) => `${v.toFixed(1)}px`;
  const radii = (r) => r.map(px).join(' ');
  const bandR = ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'].map((c) => parseFloat(bs[`border${c}Radius`]) || 0);
  const shape = (ins, r) => `inset(${ins.map(px).join(' ')} round ${radii(r)})`;
  const from = shape([E.top - F.top, F.right - E.right, F.bottom - E.bottom, E.left - F.left], bandR);
  const to = shape([0, 0, 0, 0], [12, 12, 12, 12]);
  // The board moves as one piece with the band: its far edge rides the
  // band's outer edge the whole way, like a drawer being pulled out.
  const slide = rel === 2 ? `translateY(${px(E.bottom - F.bottom)})`
    : rel === 1 ? `translateX(${px(E.right - F.right)})` : `translateX(${px(E.left - F.left)})`;

  // A copy of the band's surface laid over the board, fading as it opens up
  const cover = document.createElement('div');
  cover.className = 'focus-cover';
  for (const k of ['backgroundImage', 'backgroundColor', 'backgroundSize', 'backgroundPosition', 'backgroundRepeat', 'backgroundBlendMode']) cover.style[k] = bs[k];
  cover.style.setProperty('--seat', p.color);
  area.append(cover);

  // The band's label (name and life) rides along in the middle of the opening
  const tab = band.cloneNode(true);
  tab.classList.add('focus-tab');
  tab.classList.remove('focused', 'drop-hover');
  delete tab.dataset.drop;
  Object.assign(tab.style, { left: px(E.left - F.left), top: px(E.top - F.top), width: px(E.width), height: px(E.height) });
  area.append(tab);
  const dx = F.width / 2 - (E.left + E.width / 2 - F.left);
  const dy = F.height / 2 - (E.top + E.height / 2 - F.top);

  // One curve and one clock for every part, so it all moves together
  const timing = opening
    ? { duration: 560, easing: 'cubic-bezier(.32, .72, 0, 1)', fill: 'both' }
    : { duration: 440, easing: 'cubic-bezier(.32, .72, 0, 1)', fill: 'both', direction: 'reverse' };
  area.classList.add('animating');
  const anims = [
    area.animate([{ clipPath: from }, { clipPath: to }], timing),
    mat.animate([{ transform: slide }, { transform: 'none' }], timing),
    cover.animate([{ opacity: 1 }, { opacity: 1, offset: 0.08 }, { opacity: 0, offset: 0.6 }, { opacity: 0 }], timing),
    tab.animate([{ transform: 'none', opacity: 1 }, { opacity: 0, offset: 0.35 }, { transform: `translate(${px(dx)}, ${px(dy)})`, opacity: 0 }], timing),
  ];
  focusAnim = anims[0];
  Promise.all(anims.map((a) => a.finished)).catch(() => {}).then(() => {
    // leave the closed board hidden behind the band before taking the clip off
    if (!opening) area.hidden = true;
    area.classList.remove('animating');
    cover.remove();
    tab.remove();
    anims.forEach((a) => a.cancel());
    focusAnim = null;
    done && done();
  });
}

function updateEdge(el, p, rel) {
  el.classList.toggle('empty', !p);
  if (!p) {
    setMatArt(el, null);
    delete el.dataset.drop; delete el.dataset.player; delete el.dataset.zone;
    el.style.removeProperty('--seat');
    const open = app.s.players.length < 4;
    el.innerHTML = `<span class="edge-inner"><span class="muted">${rel === 2 && open ? `Invite: <b class="edge-code">${esc(app.code)}</b>` : 'Empty seat'}</span></span>`;
    return;
  }
  setMatArt(el, p);
  el.dataset.drop = '1';
  el.dataset.zone = 'battlefield';
  el.dataset.player = p.id;
  el.style.setProperty('--seat', p.color);
  el.classList.toggle('focused', app.focus === p.id);
  el.innerHTML = `<span class="edge-inner"><span class="dot"></span><b>${esc(p.name)}</b>${p.connected ? '' : ' <span class="offline">offline</span>'}
    <span class="spindown edge-die"><span class="val edge-life${p.life <= 5 ? ' low' : ''}">${p.life}</span></span>
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
  // A card you carried over yourself already landed where you let go of it, and
  // in the table view every mat is in sight, so the card just glides across.
  if (app.drops.has(c.id) || app.settled.has(c.id) || app.tableView) return;
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
      <div class="piles command-col">
        <div class="pile command" data-drop="1" data-zone="command" data-player="${p.id}"><div class="spot"><div class="slot"></div><span class="count"></span></div><span class="pile-label">Command</span></div>
      </div>
      <div class="battlefield" data-drop="1" data-zone="battlefield" data-player="${p.id}"></div>
      <div class="piles">
        <div class="pile library" data-drop="1" data-zone="library" data-player="${p.id}"><div class="spot"><div class="library-back"></div><span class="count"></span></div><span class="pile-label">Library</span></div>
        <div class="pile graveyard" data-drop="1" data-zone="graveyard" data-player="${p.id}"><div class="spot"><div class="slot"></div><span class="count"></span></div><span class="pile-label">Graveyard</span></div>
        <div class="pile exile" data-drop="1" data-zone="exile" data-player="${p.id}"><div class="spot"><div class="slot"></div><span class="count"></span></div><span class="pile-label">Exile</span></div>
      </div>
    </div>`;
  mat.querySelectorAll('[data-life]').forEach((b) => {
    b.onclick = () => send({ type: 'life', playerId: p.id, delta: Number(b.dataset.life) });
  });
  $('.mat-close', mat).onclick = () => setFocus(p.id);
  const body = $('.mat-body', mat);
  if (window.ResizeObserver) new ResizeObserver(() => { sizeCards(mat); fitStitches(body); }).observe(body);
  // the binding slides when the hand opens or closes; refit once it settles
  body.addEventListener('transitionend', (e) => { if (e.pseudoElement === '::after') fitStitches(body); });
  return mat;
}

// Stitched binding: stretch the stitch spacing on each straight edge a touch
// so a whole number of stitches fits between the corners, and every row meets
// its corner stitches cleanly (see .mat-body::after in app.css).
function fitStitches(body) {
  const cs = getComputedStyle(body, '::after');
  const r = parseFloat(cs.getPropertyValue('--r')) || 20;
  const fit = (len) => (len > 0 ? (len / Math.max(1, Math.round(len / 4.2))).toFixed(4) + 'px' : '4.2px');
  const w = body.clientWidth - parseFloat(cs.left) - parseFloat(cs.right) - 2 * r;
  const h = body.clientHeight - parseFloat(cs.top) - parseFloat(cs.bottom) - 2 * r;
  body.style.setProperty('--spx', fit(w));
  body.style.setProperty('--spy', fit(h));
}

// One card size per playmat, shared by the battlefield and the library,
// graveyard and exile spots, so the spots are exactly card-sized. It follows
// the mat's width, and shrinks if three spots plus labels wouldn't fit its height.
function sizeCards(mat) {
  const body = $('.mat-body', mat);
  const cs = getComputedStyle(body);
  const w = body.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const h = body.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  if (w <= 0 || h <= 0) return;
  const narrow = innerWidth <= 600;
  let cw = narrow ? Math.min(90, Math.max(34, w * 0.105)) : Math.min(130, Math.max(48, w * 0.078));
  const fitH = ((h - 14 - 3 * 18 - 2 * 8) / 3) * (63 / 88);
  cw = Math.max(30, Math.min(cw, fitH));
  mat.style.setProperty('--card-w', cw.toFixed(1) + 'px');
}

function matUrl(p) { return `/mat/${encodeURIComponent(app.code)}/${encodeURIComponent(p.id)}?v=${p.mat}`; }
function setMatArt(el, p) {
  const on = !!(p && p.mat);
  el.classList.toggle('has-art', on);
  if (on) el.style.setProperty('--mat-img', `url("${matUrl(p)}")`);
  else el.style.removeProperty('--mat-img');
}

function updateMat(mat, p, used) {
  const isMe = p.id === app.s.you;
  setMatArt(mat, p);
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
  const back = $('.library-back', lib);
  setBackArt(back, p);
  back.style.visibility = p.counts.library ? 'visible' : 'hidden';
  setStack(back, p.counts.library);
  $('.count', lib).textContent = p.counts.library;
  // Riffle the stack whenever this player shuffles (seen on every tablet).
  const seen = app.shuffleSeen.get(p.id);
  if (seen != null && p.shuffles > seen) replay(back, 'shuffling');
  app.shuffleSeen.set(p.id, p.shuffles);

  // Command zone: shown for players whose deck has a commander.
  $('.command-col', mat).hidden = !p.hasCommander;
  for (const z of ['graveyard', 'exile', 'command']) {
    const pile = $('.pile.' + z, mat);
    const list = p.zones[z];
    $('.count', pile).textContent = list.length || '';
    const slot = $('.slot', pile);
    slot.style.width = '100%';
    const top = list.length ? cardEl(list[list.length - 1], z, p, used) : null;
    syncChildren(slot, top ? [top] : []);
    if (top) setStack(top, list.length);
  }
}

// ---------- Physical feel: stacks, glides, replays ----------
// Thickness of a pile: the top card sits higher and the edges of the cards
// underneath show as thin layers, like a real stack of sleeved cards.
function setStack(el, n) {
  const layers = Math.min(14, Math.ceil(n / 5));
  const depth = Math.min(layers, 14) * 0.9;
  const edges = [];
  for (let i = 1; i <= layers; i++) {
    const c = i % 2 ? 'rgba(10,10,10,.92)' : 'color-mix(in srgb, var(--sleeve) 75%, #000)';
    edges.push(`${(i * 0.45).toFixed(2)}px ${(i * 0.9).toFixed(2)}px 0 ${c}`);
  }
  el.style.setProperty('--depth', depth.toFixed(1) + 'px');
  el.style.setProperty('--stack', edges.length ? edges.join(', ') : '0 0 0 transparent');
}

// Restart a CSS animation class, even if it's already running.
function replay(el, cls) {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
}

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
function snapshotCards() {
  const snap = new Map();
  for (const [id, el] of app.cardEls) {
    if (!el.isConnected) continue;
    const r = el.getBoundingClientRect();
    if (r.width) snap.set(id, { x: r.left + r.width / 2, y: r.top + r.height / 2, w: el.offsetWidth * zoomOf(el) });
  }
  const lib = app.matEls.get(app.s && app.s.you);
  const back = lib && $('.library-back', lib);
  if (back && back.isConnected) {
    const r = back.getBoundingClientRect();
    snap.set('LIBRARY', { x: r.left + r.width / 2, y: r.top + r.height / 2, w: back.offsetWidth * zoomOf(back) });
  }
  return snap;
}

// Cards slide from where they were to where they are now, instead of jumping.
// Cards new to my hand while my library shrank are drawn: they come off the deck.
// Cards just let go of: glide from the release point into place, then drop the ghost.
function settleDrops() {
  for (const [id, dp] of app.drops) {
    app.drops.delete(id);
    app.settled.set(id, performance.now());
    const el = app.cardEls.get(id) || dp.src;
    dp.ghost.remove();
    dp.src.classList.remove('dragging-src');
    dp.src.style.visibility = '';
    el.style.visibility = '';
    if (!el.isConnected || reduceMotion.matches || !el.animate) continue;
    const r = el.getBoundingClientRect();
    const dx = dp.x - (r.left + r.width / 2);
    const dy = dp.y - (r.top + r.height / 2);
    const s = el.offsetWidth ? dp.w / (el.offsetWidth * zoomOf(el)) : 1;
    const turn = dp.rot - cardTurn(el);
    el.animate([
      { translate: `${dx}px ${dy}px`, scale: String(s), rotate: `${turn}deg`, zIndex: 50 },
      { translate: '0px 0px', scale: '1', rotate: '0deg', zIndex: 50 },
    ], { duration: 260, easing: 'cubic-bezier(.2,.8,.25,1)' });
  }
}

function glideCards(before, mine) {
  settleDrops();
  // app.s already holds the new state by now, so remember the library's size ourselves.
  const libBefore = app.libCount;
  app.libCount = mine.counts.library;
  if (reduceMotion.matches || !Element.prototype.animate) return;
  // Switching to or from the table view moves no cards: the camera moves instead.
  if (app.tvSwitching) return;
  const now = performance.now();
  for (const [id, t] of app.settled) if (now - t > 1200) app.settled.delete(id);
  const lib = before.get('LIBRARY');
  const drew = lib && libBefore > mine.counts.library;
  const hand = new Map(mine.zones.hand.map((c) => [c.id, c]));
  let flights = 0;
  for (const [id, el] of app.cardEls) {
    if (!el.isConnected || app.settled.has(id)) continue;
    const from = before.get(id);
    if (!from) {
      // New to my hand while my library shrank: it was drawn off the deck.
      if (drew && hand.has(id)) flyDrawnCard(el, hand.get(id), lib, flights++);
      continue;
    }
    const r = el.getBoundingClientRect();
    const dx = from.x - (r.left + r.width / 2);
    const dy = from.y - (r.top + r.height / 2);
    if (Math.hypot(dx, dy) < 3) continue;
    const s = from.w && el.offsetWidth ? from.w / (el.offsetWidth * zoomOf(el)) : 1;
    el.animate(
      [{ translate: `${dx}px ${dy}px`, scale: String(s) }, { translate: '0px 0px', scale: '1' }],
      { duration: 300, easing: 'cubic-bezier(.25,.8,.3,1)' }
    );
  }
}

// Drawing a card: it lifts off the top of the library face down, arcs across
// the table into its place in the fan, and turns face up as it joins the hand.
// Only this tablet shows my hand, so nobody else sees the face.
// Several cards at once (draw 7) leave the deck one after another.
const DRAW_MS = 640;
const DRAW_GAP_MS = 120;
function flyDrawnCard(el, c, lib, i) {
  const r = el.getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight;
  if (!w || !h) return;
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const turn = cardTurn(el);
  const dx = lib.x - cx, dy = lib.y - cy;
  const s0 = lib.w ? lib.w / w : 1;

  const fly = document.createElement('div');
  fly.className = 'draw-flight';
  fly.innerHTML = '<div class="df-turn"><div class="card df-front"><span class="cname"></span><img alt="" draggable="false"></div><div class="card back df-back"></div></div>';
  Object.assign(fly.style, { left: cx - w / 2 + 'px', top: cy - h / 2 + 'px', width: w + 'px', height: h + 'px' });
  const owner = playerById(c.owner);
  if (owner) fly.style.setProperty('--owner-sleeve', owner.color);
  setBackArt(fly, owner);
  const front = fly.querySelector('.df-front');
  const img = front.querySelector('img');
  const src = c.transformed && c.back ? c.back : c.img;
  front.querySelector('.cname').textContent = c.name || '';
  if (src) { img.onerror = () => { img.style.visibility = 'hidden'; }; img.src = src; }
  else img.style.visibility = 'hidden';
  document.body.appendChild(fly);

  el.classList.add('incoming');
  const delay = i * DRAW_GAP_MS;
  // The path: off the deck, up toward you at the top of the arc, then down into the fan.
  const path = fly.animate([
    { translate: `${dx}px ${dy}px`, scale: String(s0), rotate: '0deg', offset: 0 },
    { translate: `${dx}px ${dy - 6}px`, scale: String(s0 * 1.06), rotate: '-2deg', offset: 0.12, easing: 'cubic-bezier(.3,0,.4,1)' },
    { translate: `${dx * 0.42}px ${dy * 0.5 - Math.min(60, h * 0.4)}px`, scale: String(Math.max(1.12, (s0 + 1) / 2 * 1.18)), rotate: `${turn / 2 - 6}deg`, offset: 0.55, easing: 'cubic-bezier(.35,.05,.35,1)' },
    { translate: '0px 0px', scale: '1', rotate: `${turn}deg`, offset: 1 },
  ], { duration: DRAW_MS, delay, fill: 'both' });
  // The turn over: face down until it's on its way, edge-on just past the top of
  // the arc, face up before it settles.
  fly.firstChild.animate([
    { transform: 'perspective(900px) rotateY(180deg)', offset: 0 },
    { transform: 'perspective(900px) rotateY(180deg)', offset: 0.38, easing: 'cubic-bezier(.45,0,.3,1)' },
    { transform: 'perspective(900px) rotateY(0deg)', offset: 0.9 },
    { transform: 'perspective(900px) rotateY(0deg)', offset: 1 },
  ], { duration: DRAW_MS, delay, fill: 'both' });

  const land = () => {
    fly.remove();
    el.classList.remove('incoming');
    if (!el.isConnected) return;
    // If the hand shifted while it was in the air (another draw, a card played),
    // finish with a short slide into the new spot.
    const n = el.getBoundingClientRect();
    const ox = cx - (n.left + n.width / 2), oy = cy - (n.top + n.height / 2);
    if (Math.hypot(ox, oy) > 3) el.animate([{ translate: `${ox}px ${oy}px` }, { translate: '0px 0px' }], { duration: 180, easing: 'ease-out' });
  };
  path.onfinish = path.oncancel = land;
}

function makeCardEl() {
  const el = document.createElement('div');
  el.className = 'card';
  el.innerHTML = '<span class="cname"></span><img alt="" draggable="false" loading="lazy"><span class="foil"></span>';
  // If an image fails, fall back to showing the card name.
  el.querySelector('img').onerror = function () { this.style.visibility = 'hidden'; };
  return el;
}

// ---------- Foil ----------
// A foil card lying on the table keeps its sheen still unless something changes
// how light hits it: the mouse moving over that card, tilting the tablet, or
// carrying the card (see paintGhost, which adds its momentum tilt).
// Mouse over a foil card: the sheen follows the pointer across that card only.
let hoverFoil = null;
document.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') return;
  const el = !drag && e.target.closest && e.target.closest('.card[data-finish]:not(.ghost)');
  const card = el && el.dataset.finish ? el : null;
  if (hoverFoil && hoverFoil !== card) { hoverFoil.style.setProperty('--hx', '0'); hoverFoil.style.setProperty('--hy', '0'); }
  hoverFoil = card;
  if (!card) return;
  const r = card.getBoundingClientRect();
  card.style.setProperty('--hx', ((e.clientX - r.left) / r.width - 0.5).toFixed(3));
  card.style.setProperty('--hy', ((e.clientY - r.top) / r.height - 0.5).toFixed(3));
}, { passive: true });
// Tilting the tablet turns every foil card's sheen, relative to how it was held.
let tiltBase = null;
addEventListener('deviceorientation', (e) => {
  if (e.beta == null || e.gamma == null) return;
  if (!tiltBase) tiltBase = { b: e.beta, g: e.gamma };
  tiltBase.b += (e.beta - tiltBase.b) * 0.004; tiltBase.g += (e.gamma - tiltBase.g) * 0.004; // re-centre slowly
  const clamp = (v) => Math.max(-1, Math.min(1, v));
  document.documentElement.style.setProperty('--dev-x', clamp((e.gamma - tiltBase.g) / 25).toFixed(3));
  document.documentElement.style.setProperty('--dev-y', clamp((e.beta - tiltBase.b) / 25).toFixed(3));
});
// iPad and iPhone only share motion after a tap asks for it.
if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function') {
  addEventListener('pointerup', () => { DeviceOrientationEvent.requestPermission().catch(() => {}); }, { once: true });
}

// Every tablet keeps both faces of each card on the playmats (battlefields),
// and every card back at the table, loaded and decoded ahead of time. Then a flip, transform or
// turn face up/down shows the new side straight away instead of popping in.
// (A face-down card's front is hidden from other players, so theirs can only
// load once it's turned up.)
const OFFICIAL_BACK = 'https://backs.scryfall.io/large/0/a/0aeebaf5-8c7d-4636-9e82-8c27447861f7.jpg';
const preloaded = new Map(); // url -> Image, held so the decoded picture stays ready
function preloadTableImages() {
  const s = app.s;
  if (!s) return;
  const want = new Set([OFFICIAL_BACK]);
  for (const p of s.players) {
    if (p.cardBack) want.add(new URL(backUrl(p), location.href).href);
    for (const c of (p.zones && p.zones.battlefield) || []) {
      if (c.img) want.add(c.img);
      if (c.back) want.add(c.back);
    }
  }
  for (const url of want) {
    if (preloaded.has(url)) continue;
    const im = new Image();
    im.decoding = 'async';
    im.src = url;
    if (im.decode) im.decode().catch(() => {});
    preloaded.set(url, im);
  }
  // Let go of cards that have left the playmats (hand, graveyard, library, a new deck).
  for (const url of preloaded.keys()) if (!want.has(url)) preloaded.delete(url);
}

// Fill a card element from the card's view data.
function paintCard(el, c, zone, holder) {
  el.dataset.cardId = c.id;
  el.dataset.zone = zone;
  const hidden = !c.name || (zone === 'battlefield' && c.faceDown);
  setBackArt(el, playerById(c.owner));
  el.classList.toggle('tapped', zone === 'battlefield' && !!c.tapped);
  const img = el.querySelector('img');
  const src = c.transformed && c.back ? c.back : c.img;
  const peek = zone === 'battlefield' && !!c.faceDown && !!c.name;
  // What's printed on the side facing up: the card image, or the back.
  const showFace = () => {
    el.classList.toggle('back', hidden);
    el.classList.toggle('facedown-peek', peek);
    if (!hidden && src && img.getAttribute('src') !== src) img.src = src;
    if (!src) img.removeAttribute('src');
    img.style.visibility = src ? '' : 'hidden';
    el.querySelector('.cname').textContent = hidden ? '' : c.name || '';
    el.dataset.finish = !hidden && c.finish ? c.finish : '';
    el.title = hidden ? 'Hidden card' : c.name;
  };
  // Turning a card over (transforming a double-faced card, or face down / up)
  // flips it on the table. The old side stays up until the card is edge-on,
  // exactly halfway, and the new side shows from there.
  const face = hidden ? 'back' : (c.transformed && c.back ? 'second' : 'front');
  const flipped = el.dataset.face && el.dataset.face !== face && el.isConnected && el.dataset.cardId === c.id;
  el.dataset.face = face;
  if (el.flipping) {
    el.flipping.showFace = showFace; // mid-flip: the latest side goes up at the halfway point
  } else if (flipped && el.animate && !reduceMotion.matches) {
    if (!hidden && src) new Image().src = src; // have the new side ready by the halfway point
    const flip = { showFace };
    el.flipping = flip;
    const half = el.animate([{ rotate: 'y 0deg' }, { rotate: 'y 90deg' }], { duration: 160, easing: 'ease-in' });
    half.onfinish = half.oncancel = () => {
      flip.showFace();
      el.flipping = null;
      el.animate([{ rotate: 'y -90deg' }, { rotate: 'y 0deg' }], { duration: 160, easing: 'ease-out' });
    };
  } else showFace();

  let ctr = el.querySelector('.ctr');
  if (zone === 'battlefield' && c.counters) {
    if (!ctr) { ctr = document.createElement('span'); ctr.className = 'ctr'; el.appendChild(ctr); }
    ctr.textContent = c.counters > 0 ? '+' + c.counters : c.counters;
  } else if (ctr) ctr.remove();

  // Coloured dot = someone else's card sitting on this playmat.
  let dot = el.querySelector('.owner-dot');
  const owner = playerById(c.owner);
  if (owner) el.style.setProperty('--owner-sleeve', owner.color);
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
  // Fan the cards like they're held: a few degrees each, edges dipping lower.
  const step = Math.min(5, 36 / Math.max(1, n - 1));
  [...hand.children].forEach((el, i) => {
    const k = i - (n - 1) / 2;
    el.style.setProperty('--rot', (k * step).toFixed(2) + 'deg');
    el.style.setProperty('--dy', (Math.abs(k) * Math.abs(k) * step * 0.18 + 4).toFixed(1) + 'px');
  });
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
    w: src.offsetWidth * zoomOf(src), h: src.offsetHeight * zoomOf(src),
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
  const t = dropTargetAt(e.clientX, e.clientY);
  highlight(t);
  sizeGhostFor(drag, t);
  placeGhost(drag, e.clientX, e.clientY, t);
  spreadHand(drag, t, e.clientX);
}, { passive: false });

document.addEventListener('pointerup', (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const d = drag;
  drag = null;
  clearTimeout(d.timer);
  if (d.started) {
    d.samples.push({ x: e.clientX, y: e.clientY, t: performance.now() });
    spreadHand(d, null);
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
  if (drag.fromLibrary) setBackArt(ghost, me());
  ghost.classList.remove('tapped');
  ghost.style.width = drag.w + 'px';
  ghost.style.height = drag.h + 'px';
  // Start exactly where the card lies (same size and turn), with the pointer as the
  // pivot, so picking it up lifts and straightens it instead of jumping.
  const r = drag.src.getBoundingClientRect();
  const gx = r.left + r.width / 2 - drag.w / 2;
  const gy = r.top + r.height / 2 - drag.h / 2;
  drag.ox = drag.sx - gx; drag.oy = drag.sy - gy;
  ghost.style.left = drag.x - drag.ox + 'px';
  ghost.style.top = drag.y - drag.oy + 'px';
  ghost.style.transformOrigin = `${drag.ox}px ${drag.oy}px`;
  drag.rot0 = cardTurn(drag.src);
  ghost.style.transform = `rotate(${drag.rot0}deg)`;
  // Foil sheen starts exactly as it looked on the table, then shifts as the card travels.
  ghost.style.setProperty('--fx0', (drag.x / innerWidth).toFixed(3));
  ghost.style.setProperty('--fy0', (drag.y / innerHeight).toFixed(3));
  ghost.style.setProperty('--fx', (drag.x / innerWidth).toFixed(3));
  ghost.style.setProperty('--fy', (drag.y / innerHeight).toFixed(3));
  document.body.appendChild(ghost);
  drag.ghost = ghost;
  drag.size = drag.w;
  void ghost.offsetWidth;
  ghost.classList.add('lifted');
  sizeGhostFor(drag, null);
  const held = drag;
  requestAnimationFrame(() => tiltLoop(held));
  drag.src.classList.add('dragging-src');
  // Dragging from inside a pile viewer: close the sheet so the table is reachable.
  if (drag.src.closest('#sheet')) closeSheet();
}

// How far a card is turned where it lies: tapped, or fanned in the hand.
function cardTurn(el) {
  if (el.classList.contains('tapped')) return 90;
  if (el.closest('#hand')) return parseFloat(el.style.getPropertyValue('--rot')) || 0;
  return 0;
}

// The size a card has in a given area, so a carried card can match it.
function cardWidthIn(t) {
  if (!t) return null;
  if (t.id === 'handBar') return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hand-cw')) || null;
  const spot = t.querySelector && t.querySelector('.spot');
  if (spot) return spot.offsetWidth * zoomOf(spot);
  const mat = t.closest('.mat');
  if (mat) return (parseFloat(mat.style.getPropertyValue('--card-w')) || 0) * zoomOf(mat) || null;
  return null;
}

// A carried card is held a little bigger than it lies (lifted toward you), and
// eases to the size of whatever area it's over.
const LIFT = 1.18;
function sizeGhostFor(d, t) {
  const tw = cardWidthIn(t);
  if (tw) d.size = tw;
  // Over a pile it settles to the pile's exact size; elsewhere it's held lifted.
  const onPile = t && t.classList.contains('pile') && commandOk(d, t);
  const s = (d.size / d.w) * (onPile ? 1 : LIFT);
  d.scale = s;
  paintGhost(d);
}

// A carried card leans with its momentum: the leading edge dips toward the
// table, then settles when you stop.
// The ghost's transform transition smooths every change, so it eases like a
// real card in the air.
const TILT_MAX = 20; // degrees
function paintGhost(d) {
  const t = d.snap ? { x: 0, y: 0 } : d.tilt || { x: 0, y: 0 };
  // The carried card's tilt also turns its foil sheen.
  d.ghost.style.setProperty('--tilt-x', (t.y / TILT_MAX).toFixed(3));
  d.ghost.style.setProperty('--tilt-y', (-t.x / TILT_MAX).toFixed(3));
  // The tilt is in screen directions and pivots on the card's centre, separate
  // from the small turn a card gets when picked up (none once snapped to a pile).
  const cx = (d.scale * (d.w / 2 - d.ox)).toFixed(1), cy = (d.scale * (d.h / 2 - d.oy)).toFixed(1);
  const turn = d.snap ? 0 : 2;
  d.ghost.style.transform = `translate(${cx}px, ${cy}px) perspective(700px) rotateX(${t.x.toFixed(2)}deg) rotateY(${t.y.toFixed(2)}deg) translate(${-cx}px, ${-cy}px) rotate(${turn}deg) scale(${d.scale.toFixed(3)})`;
}

// Over a pile (graveyard, exile, library, command zone) the carried card lets go
// of the finger and glides onto the pile's spot, square and the same size, so
// you can see exactly where it will land. Moving off the pile glides it back.
function placeGhost(d, x, y, t) {
  const g = d.ghost;
  const spot = t && t.classList.contains('pile') && t.querySelector('.spot');
  const was = d.snap;
  d.snap = spot && commandOk(d, t) ? spot : null;
  if (d.snap) {
    const r = d.snap.getBoundingClientRect();
    // The card scales around the finger, so place it so its scaled centre sits on the spot's centre.
    g.style.left = r.left + r.width / 2 - d.ox - d.scale * (d.w / 2 - d.ox) + 'px';
    g.style.top = r.top + r.height / 2 - d.oy - d.scale * (d.h / 2 - d.oy) + 'px';
  } else {
    g.style.left = x - d.ox + 'px';
    g.style.top = y - d.oy + 'px';
  }
  g.style.setProperty('--fx', (x / innerWidth).toFixed(3));
  g.style.setProperty('--fy', (y / innerHeight).toFixed(3));
  if (!!d.snap !== !!was || (d.snap && d.snap !== was)) {
    // Glide for a moment when snapping on or off; otherwise follow the finger exactly.
    g.classList.add('snapping');
    clearTimeout(d.snapTimer);
    if (!d.snap) d.snapTimer = setTimeout(() => g.classList.remove('snapping'), 180);
    paintGhost(d);
  }
}

// Carrying a card over your hand: the cards part where it would go in.
function spreadHand(d, t, x) {
  const hand = $('#hand');
  const cards = [...hand.children];
  if (!t || t.id !== 'handBar') {
    if (hand.classList.contains('parting')) { hand.classList.remove('parting'); cards.forEach((c) => c.style.removeProperty('--dx')); }
    return;
  }
  const others = cards.filter((c) => c !== d.src);
  let idx = others.findIndex((c) => { const r = c.getBoundingClientRect(); return x < r.left + r.width / 2; });
  if (idx < 0) idx = others.length;
  const cw = others[0] ? others[0].offsetWidth : 70;
  const gap = cw * 0.55;
  hand.classList.add('parting');
  others.forEach((c, i) => c.style.setProperty('--dx', (i < idx ? -gap / 2 : gap / 2).toFixed(1) + 'px'));
  if (cards.includes(d.src)) d.src.style.setProperty('--dx', '0px');
}
function tiltLoop(d) {
  if (!d || drag !== d || !d.ghost || reduceMotion.matches) return;
  const now = performance.now();
  const sm = d.samples;
  let vx = 0, vy = 0;
  if (sm.length > 1 && now - sm[sm.length - 1].t < 60) {
    const a = sm[0], b = sm[sm.length - 1];
    const dt = Math.max(16, b.t - a.t);
    vx = (b.x - a.x) / dt; vy = (b.y - a.y) / dt; // px per ms
  }
  const clamp = (v, m) => Math.max(-m, Math.min(m, v));
  // Where the finger holds the card: held above centre, sideways motion swings the bottom back.
  const want = { x: clamp(-vy * 12, TILT_MAX), y: clamp(vx * 12, TILT_MAX) };
  const t = d.tilt || (d.tilt = { x: 0, y: 0 });
  if (Math.abs(want.x - t.x) + Math.abs(want.y - t.y) > 0.15) {
    t.x = want.x; t.y = want.y;
    paintGhost(d);
  }
  requestAnimationFrame(() => tiltLoop(d));
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
  spreadHand(d, null);
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
  if (app.tableView) return false; // every mat is in reach: just drag
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
  app.settled.set(d.id, performance.now());
  const finish = () => {
    g.remove();
    d.src.classList.remove('dragging-src');
    d.src.style.visibility = '';
  };
  if (g.animate) {
    g.style.transition = 'none';
    g.animate([{ transform: g.style.transform }, { transform: `translate(${tx}px, ${ty}px) rotate(${vx > 0 ? 40 : -40}deg) scale(${(d.scale * 0.85).toFixed(3)})` }],
      { duration: 380, easing: 'cubic-bezier(.3,.6,.4,1)', fill: 'forwards' }).onfinish = finish;
  } else finish();
  const spot = landingSpot(me(), to);
  send({ type: 'move', cardId: d.id, toPlayer: to.id, toZone: 'battlefield', x: spot.x, y: spot.y });
  toast(`Sent to ${to.name}`);
}

// Put a carried card back where it came from, smoothly (nowhere to drop it).
function returnGhost(d) {
  highlight(null);
  const g = d.ghost;
  if (!g || !g.animate || reduceMotion.matches) return cleanupDrag(d);
  const r = d.src.getBoundingClientRect();
  const gx = r.left + r.width / 2 - d.w / 2;
  const gy = r.top + r.height / 2 - d.h / 2;
  g.style.transition = 'none';
  g.animate([
    { transform: g.style.transform },
    { transform: `translate(${gx - parseFloat(g.style.left)}px, ${gy - parseFloat(g.style.top)}px) rotate(${d.rot0}deg) scale(1)` },
  ], { duration: 260, easing: 'cubic-bezier(.3,.7,.3,1)', fill: 'forwards' }).onfinish = () => cleanupDrag(d);
}

// Hand the carried card over to the real one: remember where (and how big and
// turned) it was let go, so the real card glides from there into its new spot.
function releaseGhost(d) {
  highlight(null);
  const g = d.ghost;
  const r = g.getBoundingClientRect();
  const drop = { x: r.left + r.width / 2, y: r.top + r.height / 2, w: d.w * d.scale, rot: 2, ghost: g, src: d.src, t: performance.now() };
  d.src.style.visibility = 'hidden';
  app.drops.set(d.id, drop);
  // If no table update arrives (e.g. the move was refused), settle back anyway.
  setTimeout(() => { if (app.drops.get(d.id) === drop) { app.drops.delete(d.id); d.src.style.visibility = ''; returnGhost(d); } }, 1500);
}

function finishDrag(d, x, y) {
  const target = dropTargetAt(x, y);
  if (!target || d.fromLibrary) {
    if (!target) return returnGhost(d);
    cleanupDrag(d);
  } else if (!commandOk(d, target)) {
    returnGhost(d);
    return toast('Only your commander goes in your command zone.');
  } else releaseGhost(d);
  if (!target) return;
  // Where the card's top-left lands, at the size it will have there.
  const k = (cardWidthIn(target) || d.w) / d.w;
  d.offX = d.ox * k; d.offY = d.oy * k;
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
      settleDrops();
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

// Only commanders move in or out of the command zone (the server checks too).
function commandOk(d, target) {
  const into = target.dataset.zone === 'command';
  const outOf = d.node.closest && d.node.closest('.pile.command');
  if (!into && !outOf) return true;
  if (d.fromLibrary) return false;
  const f = findCard(d.id);
  return !!(f && f.card.commander && (!into || target.dataset.player === f.card.owner));
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
  const f = findCard(cardId);
  const cmdr = f && f.card.commander ? f.card : null;
  const order = [me(), ...app.s.players.filter((p) => p.id !== app.s.you).sort((a, b) => a.seat - b.seat)];
  return order.map((p) => `
    <div class="move-row" style="--seat:${p.color}">
      <div class="who"><span class="dot"></span>${esc(p.id === app.s.you ? 'You' : p.name)}</div>
      <div class="chips">
        ${['hand', 'battlefield', 'graveyard', 'exile'].map((z) => `<button class="chip" data-move="${z}" data-player="${p.id}">${ZONE_LABEL[z]}</button>`).join('')}
        ${cmdr && p.id === cmdr.owner ? `<button class="chip" data-move="command" data-player="${p.id}">Command zone</button>` : ''}
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
      <div class="sheet-card ${visible ? '' : 'back'}" style="${!visible && owner && owner.cardBack ? `--card-back:url('${backUrl(owner)}')` : ''}">${visible && src ? `<img src="${esc(src)}" alt="${esc(c.name)}">` : ''}</div>
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
      if (op === 'peekBack') { const im = $('.sheet-card img', sheet); im.src = im.getAttribute('src') === c.back ? c.img : c.back; return; }
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
    <h3>${esc(p.id === app.s.you ? 'Your' : p.name + "'s")} ${ZONE_LABEL[zone].toLowerCase()} (${list.length})</h3>
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
const SAMPLE_DECK = `// Sample: mono-red aggro (60 cards), with some foil (*F*) and etched (*E*) cards
2 Monastery Swiftspear
2 Monastery Swiftspear *F*
3 Goblin Guide
1 Goblin Guide *E*
4 Bloodthirsty Adversary
3 Kumano Faces Kakkazan
1 Kumano Faces Kakkazan *F*
2 Lightning Bolt
2 Lightning Bolt *F*
4 Play with Fire
4 Light Up the Stage
3 Skewer the Critics
1 Skewer the Critics *E*
3 Embercleave
1 Embercleave *E*
1 Fable of the Mirror-Breaker
1 Fable of the Mirror-Breaker *F*
2 Delver of Secrets *F*
16 Mountain
4 Mountain *F*`;

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
    const key = [c.name, c.img, c.back, c.commander ? 1 : 0, c.finish || ''].join('|');
    const hit = byKey.get(key);
    if (hit) hit.qty++;
    else { const e = { name: c.name, img: c.img, back: c.back, commander: !!c.commander, qty: 1 }; if (c.finish) e.finish = c.finish; byKey.set(key, e); out.push(e); }
  }
  return out;
}
// With a deck's custom art map, each card also carries the art ids for its faces.
function unpackCards(packed, art) {
  const out = [];
  for (const c of packed) {
    const a = art ? artIdsFor(art, c) : {};
    for (let k = 0; k < (c.qty || 1); k++) out.push({ name: c.name, img: c.img, back: c.back, commander: c.commander, finish: c.finish, ...a });
  }
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
function saveDeck({ id, name, text, cards, colors, cardBack }) {
  const decks = loadDecks();
  const deck = { id: id || 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: name.slice(0, 60), text, cards: packCards(cards), colors: colors || null, updated: Date.now() };
  if (cardBack) deck.cardBack = cardBack;
  const i = decks.findIndex((d) => d.id === deck.id);
  // Custom card art is keyed by card name, so it survives editing the list.
  if (i >= 0 && decks[i].art) deck.art = decks[i].art;
  if (i >= 0) decks[i] = deck; else decks.push(deck);
  storeDecks(decks);
  return deck;
}
function deleteDeck(id) {
  storeDecks(loadDecks().filter((d) => d.id !== id));
  if (pickedDeckId() === id) setPickedDeck('');
  pruneArt();
}

// Home screen deck picker: a shelf of card stacks you scroll sideways.
// Each deck is a sleeved stack whose height follows its size, with its
// commander (or first spell) face up on top. The picked deck is lifted.
const SLEEVES = ['#4f7fd0', '#c0504d', '#4f9a6c', '#8a6cc2', '#d08a3a', '#3f9aa6', '#b5577f'];
const BASICS = new Set(['plains', 'island', 'swamp', 'mountain', 'forest', 'wastes']);
function sleeveOf(d) {
  let h = 0;
  for (const ch of d.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return SLEEVES[h % SLEEVES.length];
}
function faceCardOf(d) {
  return d.cards.find((c) => c.commander && c.img)
    || d.cards.find((c) => c.img && !BASICS.has(norm(c.name).replace(/^snow-covered /, '')))
    || d.cards.find((c) => c.img) || null;
}

// Colour identity in the usual W U B R G order, shown as the official mana
// symbols (from Scryfall) in the deck's top-left corner. Colourless decks get {C}.
// If a symbol can't load, the CSS pip with its letter underneath shows instead.
const COLOR_ORDER = ['W', 'U', 'B', 'R', 'G'];
const COLOR_NAME = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green', C: 'colorless' };
function sortColors(set) { return COLOR_ORDER.filter((c) => set.has(c)); }
function manaPips(colors) {
  if (!Array.isArray(colors)) return '';
  const list = colors.length ? colors : ['C'];
  const label = list.map((c) => COLOR_NAME[c]).join(', ');
  return `<span class="deck-pips" role="img" aria-label="${label}" title="${label}">${list.map((c) => `<span class="pip pip-${c}">${c}<img src="https://svgs.scryfall.io/card-symbols/${c}.svg" alt="" draggable="false" onerror="this.remove()"></span>`).join('')}</span>`;
}

// Decks saved before colours were recorded: look their cards up once and store the colours.
let fillingColors = false;
async function fillDeckColors() {
  if (fillingColors) return;
  const todo = loadDecks().filter((d) => !Array.isArray(d.colors));
  if (!todo.length) return;
  fillingColors = true;
  try {
    for (const d of todo) {
      // "Flavor name (Real name)" entries keep the real name in brackets.
      const names = [...new Set(d.cards.map((c) => { const m = c.name.match(/\(([^()]+)\)$/); return (m ? m[1] : c.name).split(' // ')[0]; }))];
      const colors = new Set();
      for (let i = 0; i < names.length; i += 75) {
        const data = await scryfallCollection(names.slice(i, i + 75).map((name) => ({ name })));
        for (const c of data.data || []) for (const x of c.color_identity || []) colors.add(x);
        await sleep(550);
      }
      const all = loadDecks();
      const hit = all.find((x) => x.id === d.id);
      if (!hit) continue;
      hit.colors = sortColors(colors);
      storeDecks(all);
      if (!$('#landing').hidden) renderLandingDecks();
    }
  } catch { /* offline or Scryfall busy: try again next time */ }
  fillingColors = false;
}

function renderLandingDecks() {
  const shelf = $('#deckList');
  const scroll = shelf.scrollLeft;
  const decks = loadDecks();
  let pick = pickedDeckId();
  if (pick && !decks.some((d) => d.id === pick)) pick = '';
  const tile = (d) => {
    const face = faceCardOf(d);
    const on = pick === d.id;
    return `
    <label class="deck-tile${on ? ' picked' : ''}">
      <input class="sr-only" type="radio" name="deckPick" value="${esc(d.id)}" ${on ? 'checked' : ''}>
      <span class="deck-stack" data-size="${deckSize(d)}" style="--sleeve:${sleeveOf(d)}">
        <span class="deck-top${face ? '' : ' back'}">${face ? `<img src="${esc(face.img)}" alt="" loading="lazy" draggable="false"${d.art && d.art[artKey(face.name)] ? ` data-art="${esc(d.art[artKey(face.name)])}"` : ''}>` : ''}</span>
        <span class="deck-qty">${deckSize(d)}</span>
        ${manaPips(d.colors)}
      </span>
      <span class="deck-label">${esc(d.name)}</span>
      ${on ? `<span class="deck-actions">
        <button type="button" class="link-btn" data-deck-edit="${esc(d.id)}">Edit</button>
        <button type="button" class="link-btn" data-deck-art="${esc(d.id)}">Art</button>
        <button type="button" class="link-btn danger" data-deck-del="${esc(d.id)}">Delete</button>
      </span>` : ''}
    </label>`;
  };
  shelf.innerHTML = decks.map(tile).join('') + (decks.length ? `
    <label class="deck-tile none${pick ? '' : ' picked'}">
      <input class="sr-only" type="radio" name="deckPick" value="" ${pick ? '' : 'checked'}>
      <span class="deck-spot">No deck</span>
      <span class="deck-label">Pick one at the table</span>
    </label>` : '') + `
    <button type="button" class="deck-tile add" data-deck-add>
      <span class="deck-spot"><span class="plus">+</span></span>
      <span class="deck-label">Import a deck</span>
    </button>`;
  shelf.querySelectorAll('.deck-stack').forEach((el) => setStack(el, Number(el.dataset.size)));
  shelf.querySelectorAll('img[data-art]').forEach(async (im) => { const u = await artObjectUrl(im.dataset.art); if (u) im.src = u; });
  shelf.scrollLeft = scroll;
  const picked = decks.find((d) => d.id === pick);
  $('#deckTabPick').textContent = picked ? '· ' + picked.name : decks.length ? '· none picked' : '';
}

// The drawer remembers whether you left it open or tucked away.
function setDeckDrawer(open) {
  $('#landing').classList.toggle('decks-hidden', !open);
  $('#deckTab').setAttribute('aria-expanded', String(open));
  try { localStorage.setItem('ps:decksOpen', open ? '1' : '0'); } catch {}
}
$('#deckTab').onclick = () => setDeckDrawer($('#landing').classList.contains('decks-hidden'));
try { if (localStorage.getItem('ps:decksOpen') === '0') setDeckDrawer(false); } catch {}
$('#deckList').addEventListener('change', (e) => {
  if (e.target.name !== 'deckPick') return;
  setPickedDeck(e.target.value);
  renderLandingDecks();
});
$('#deckList').addEventListener('click', (e) => {
  if (e.target.closest('[data-deck-add]')) return openDeckSheet({ mode: 'landing' });
  const edit = e.target.closest('[data-deck-edit]');
  const del = e.target.closest('[data-deck-del]');
  const art = e.target.closest('[data-deck-art]');
  if (!edit && !del && !art) return;
  e.preventDefault(); // don't also pick the tile
  if (art) return openArtSheet(art.dataset.deckArt);
  if (edit) return openDeckSheet({ mode: 'landing', editId: edit.dataset.deckEdit });
  if (del.dataset.armed) { deleteDeck(del.dataset.deckDel); return renderLandingDecks(); }
  del.dataset.armed = '1';
  del.textContent = 'Sure?';
  setTimeout(() => { if (del.isConnected) { delete del.dataset.armed; del.textContent = 'Delete'; } }, 3000);
});

// Right after sitting down: shuffle in the deck picked on the landing page,
// unless this seat already has cards (rejoining a game in progress).
function bringPendingDeck() {
  const deck = app.pendingDeck;
  const m = me();
  if (!m) return;
  app.pendingDeck = null;
  const owned = Object.values(m.counts || {}).reduce((a, b) => a + b, 0);
  if (owned > 0) return;
  bringDeck(deck, `${deck.name} is shuffled into your library. Tap your library to draw.`);
}

function loadSavedDeck(id) {
  const deck = deckById(id);
  if (!deck) return;
  setPickedDeck(deck.id);
  closeSheet();
  bringDeck(deck, `Loaded ${deck.name} (${deckSize(deck)} cards) and shuffled. Tap your library to draw.`);
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
    <p class="note">Paste a public Moxfield deck link, or a deck list with one card per line, like <code>4 Lightning Bolt</code>. Export from Moxfield, Archidekt, MTG Arena, MTGO and most other deckbuilders works ("Export → Text"). Lines under a <code>Sideboard</code> heading are skipped. Cards under a <code>Commander</code> heading start in your command zone.</p>
    <textarea id="deckText" spellcheck="false" placeholder="https://moxfield.com/decks/…&#10;or&#10;4 Lightning Bolt&#10;20 Mountain">${esc(saved)}</textarea>
    <div class="back-field">
      <div class="back-preview card-back-art"></div>
      <div class="back-side">
        <span class="back-title">Card back</span>
        <div class="row">
          <label class="btn small">Choose a picture<input type="file" accept="image/*" id="backFile" hidden></label>
          <button type="button" class="btn small" id="backClear">Use the official back</button>
        </div>
        <p class="note" id="backMsg"></p>
      </div>
    </div>
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
  app.backDraft = editing ? editing.cardBack || '' : '';
  showBackDraft();
  $('#backFile').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    $('#backMsg').textContent = 'Preparing your picture…';
    try { app.backDraft = await shrinkCardBack(file); showBackDraft(); }
    catch { $('#backMsg').textContent = "That picture couldn't be used. Try a JPEG or PNG."; }
  };
  $('#backClear').onclick = () => { app.backDraft = ''; showBackDraft(); };
  $('#deckSample').onclick = () => { $('#deckText').value = SAMPLE_DECK; };
  $('#deckLoad').onclick = () => {
    const text = $('#deckText').value;
    // Only the name or card back changed: no need to look the cards up again.
    if (editing && text === editing.text) return finishImport(text, unpackCards(editing.cards), [], editing.colors);
    importDeck(text);
  };
  $('#sheet').querySelectorAll('[data-deck-load]').forEach((b) => { b.onclick = () => loadSavedDeck(b.dataset.deckLoad); });
}

// After the Scryfall lookup: save the deck and/or put it on the table, as the sheet asks.
function finishImport(text, cards, notFound, colors) {
  const status = $('#deckStatus');
  if (!cards.length) return (status.textContent = 'None of those cards were found on Scryfall.');
  const opts = sheetData || { mode: 'game' };
  const name = $('#deckName').value.trim() || guessDeckName(text, cards);
  const wantSave = opts.mode === 'landing' || ($('#deckSave') && $('#deckSave').checked);
  let deck = null;
  let saveErr = '';
  if (wantSave) {
    try { deck = saveDeck({ id: opts.editId, name, text, cards, colors, cardBack: app.backDraft }); } catch { saveErr = ' This device has no room left to save it.'; }
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
  if (deck && deck.art) bringDeck(deck);
  else send({ type: 'loadDeck', cards, cardBack: app.backDraft || null });
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
    // Tags deckbuilders add after the name: *CMDR*, and the finish as *F* (foil)
    // or *E* (etched), or written out like (Foil) / [Etched Foil].
    let finish = '';
    rest = rest.replace(/\s*\*([A-Za-z]+)\*/g, (_, tag) => {
      const t = tag.toUpperCase();
      if (t === 'CMDR') commander = true;
      else if (t === 'F' || t === 'FOIL') finish = finish || 'foil';
      else if (t === 'E' || t === 'ETCHED') finish = 'etched';
      return '';
    });
    rest = rest.replace(/\s*[\[(]\s*(foil[\s-]*etched|etched(?:[\s-]*foil)?|foil)\s*[\])]/ig, (_, f) => {
      finish = /etched/i.test(f) ? 'etched' : finish || 'foil';
      return '';
    });
    rest = rest.replace(/\s+#.*$/, '').replace(/\s+\[[^\]]*\]\s*$/, '');
    let set = null, num = null;
    const sm = rest.match(/^(.*?)\s+\(([A-Za-z0-9]{2,6})\)\s*([A-Za-z0-9\-★]+)?\s*$/);
    if (sm) { rest = sm[1]; set = sm[2].toLowerCase(); num = sm[3] || null; }
    const name = rest.trim();
    if (name) out.push({ qty, name, set, num, commander, finish });
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
  const colors = new Set();
  entries.forEach((e, i) => {
    const sc = resolved.get(i);
    if (!sc) return notFound.push(e.name);
    for (const c of sc.color_identity || []) colors.add(c);
    const im = imagesOf(sc);
    // Keep the name the player knows it by, with the real name alongside when they differ.
    const alt = norm(e.name) !== norm(sc.name) && !norm(sc.name).startsWith(norm(e.name) + ' //');
    const name = alt ? `${e.name} (${sc.name})` : sc.name;
    for (let k = 0; k < e.qty; k++) cards.push({ name, img: im.img, back: im.back, commander: e.commander, finish: e.finish });
  });
  $('#deckLoad').disabled = false;
  finishImport(mox ? pasted : text, cards, notFound, sortColors(colors));
}

// ---------- Custom card art ----------
// Any card in a saved deck can use your own picture instead of Scryfall's:
// pick one card at a time, or drop a pile of files and they're matched to the
// deck's cards by file name. Pictures are cropped to card shape, shrunk to a
// small JPEG and kept on this device (IndexedDB, which has far more room than
// the deck list). The deck only stores which picture goes with which card name,
// so the art stays put when the list is edited. When the deck comes to the
// table each picture is uploaded once, and every tablet shows it.
const artUrls = new Map(); // art id -> object URL for this page
let artDbOpen = null;
function artDb() {
  if (!artDbOpen) {
    artDbOpen = new Promise((ok, fail) => {
      const req = indexedDB.open('planar-bridge', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('art');
      req.onsuccess = () => ok(req.result);
      req.onerror = () => fail(req.error);
    });
    artDbOpen.catch(() => { artDbOpen = null; });
  }
  return artDbOpen;
}
async function artStore(mode, fn) {
  const db = await artDb();
  return new Promise((ok, fail) => {
    const tx = db.transaction('art', mode);
    const req = fn(tx.objectStore('art'));
    tx.oncomplete = () => ok(req && req.result);
    tx.onerror = tx.onabort = () => fail(tx.error);
  });
}
const getArt = (id) => artStore('readonly', (st) => st.get(id)).catch(() => null);
const putArt = (id, blob) => artStore('readwrite', (st) => st.put(blob, id));
async function artObjectUrl(id) {
  if (artUrls.has(id)) return artUrls.get(id);
  const blob = await getArt(id);
  if (!blob) return '';
  const u = URL.createObjectURL(blob);
  artUrls.set(id, u);
  return u;
}
// Forget pictures no saved deck uses any more.
async function pruneArt() {
  const used = new Set(loadDecks().flatMap((d) => Object.values(d.art || {})));
  try {
    const keys = await artStore('readonly', (st) => st.getAllKeys());
    const gone = (keys || []).filter((k) => !used.has(k));
    if (gone.length) await artStore('readwrite', (st) => { for (const k of gone) st.delete(k); });
    for (const k of gone) { const u = artUrls.get(k); if (u) URL.revokeObjectURL(u); artUrls.delete(k); }
  } catch { /* storage unavailable: nothing to tidy */ }
}
async function shrinkCardArt(file) {
  const c = await cardCanvas(file);
  for (const q of [0.88, 0.8, 0.7, 0.6, 0.5]) {
    const blob = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', q));
    if (blob && blob.size < 160 * 1024) return blob;
  }
  throw new Error('too big');
}
const newArtId = () => 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// Art is keyed by the card's name, plus "//back" for a double-faced card's second face.
function artKey(name, second) { return norm(name) + (second ? ' //back' : ''); }
function artIdsFor(art, c) {
  const out = {};
  if (art[artKey(c.name)]) out.art = art[artKey(c.name)];
  if (c.back && art[artKey(c.name, true)]) out.artBack = art[artKey(c.name, true)];
  return out;
}
// Each side of each different card in a deck that can have its own picture.
function artSlots(deck) {
  const out = [];
  const seen = new Set();
  for (const c of deck.cards) {
    const faces = c.name.replace(/\s*\([^()]*\)$/, '').split(' // ');
    for (const second of c.back ? [false, true] : [false]) {
      const key = artKey(c.name, second);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, card: c, second, label: c.back ? faces[second ? 1 : 0] || c.name : c.name, img: second ? c.back : c.img });
    }
  }
  return out;
}

// File names are matched loosely: case, accents, punctuation, and spaces vs
// underscores vs hyphens don't matter. "lightning_bolt.png", "Lightning-Bolt (2).jpg",
// "4x Lightning Bolt [M10].jpeg" and "LightningBolt.webp" all find Lightning Bolt.
// For a double-faced card either face's name works, and "... back" / "... front"
// picks the side.
function looseName(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\u00e6/g, 'ae').replace(/\u0153/g, 'oe')
    .replace(/[’'`"]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
function fileNameGuesses(fileName) {
  let base = String(fileName).replace(/\.[a-z0-9]{2,5}$/i, '');
  base = base.replace(/\s*[\[{][^\]}]*[\]}]/g, ' '); // [set] or {tags}
  let n = looseName(base.replace(/\s*\((?:\d+|copy)\)\s*$/i, ''));
  let side = null;
  const sm = n.match(/^(.*?)\s+(front|back|side a|side b|face 1|face 2|1st face|2nd face)$/);
  if (sm) { n = sm[1]; side = /back|side b|face 2|2nd/.test(sm[2]) ? 'back' : 'front'; }
  const out = [n];
  const noQty = n.replace(/^\d+\s*x?\s+/, '');
  out.push(noQty);
  // Trailing extras people add: "art", "proxy", "alt", "final", "v2", a copy number.
  out.push(noQty.replace(/(\s+(art|artwork|proxy|custom|alt|alter|altered|final|edit|copy|v\d+|\d+))+$/, ''));
  out.push(noQty.replace(/\s+\d+$/, '').replace(/^[a-z0-9]{2,5}\s+\d+\s+/, '')); // "mh2 123 name"
  return { names: [...new Set(out.filter(Boolean))], side };
}
function matchArtFile(fileName, slots) {
  const { names, side } = fileNameGuesses(fileName);
  // Every name a slot answers to: the face's name, the whole card's name,
  // and both halves of "Flavor name (Real name)".
  const index = [];
  for (const s of slots) {
    const whole = s.card.name;
    const real = (whole.match(/\(([^()]+)\)$/) || [])[1];
    const shown = whole.replace(/\s*\([^()]*\)$/, '');
    const names = new Set([s.label, shown, real].filter(Boolean));
    if (!s.second) { names.add(whole); for (const n of [shown, real]) if (n) names.add(n.split(' // ')[0]); }
    else for (const n of [shown, real]) if (n && n.includes(' // ')) names.add(n.split(' // ')[1]);
    for (const n of names) {
      const l = looseName(n);
      index.push({ slot: s, loose: l, tight: l.replace(/ /g, ''), front: !s.second });
    }
  }
  const pick = (hits) => {
    const cards = new Set(hits.map((h) => h.slot.card.name));
    if (cards.size !== 1) return null;
    const want = side === 'back' ? (h) => h.slot.second : side === 'front' ? (h) => !h.slot.second : (h) => h.front;
    return (hits.find(want) || hits.find((h) => h.front) || hits[0]).slot;
  };
  // A side named in the file ("... back") also finds the other face of the same card.
  const withSide = (hit) => {
    if (!hit || !side) return hit;
    const other = slots.find((s) => s.card.name === hit.card.name && s.second === (side === 'back'));
    return other || hit;
  };
  for (const n of names) {
    const exact = pick(index.filter((h) => h.loose === n));
    if (exact) return withSide(exact);
  }
  for (const n of names) {
    const t = n.replace(/ /g, '');
    const tight = pick(index.filter((h) => h.tight === t));
    if (tight) return withSide(tight);
  }
  // A short name, like a legend's first name ("Sephiroth"), if only one card starts with it.
  for (const n of names) {
    if (n.length < 4) continue;
    const pre = pick(index.filter((h) => h.loose.startsWith(n + ' ')));
    if (pre) return withSide(pre);
  }
  return null;
}

// Save one picture for one side of a card in a saved deck.
async function setDeckArt(deckId, key, file) {
  const blob = await shrinkCardArt(file);
  const id = newArtId();
  await putArt(id, blob);
  const decks = loadDecks();
  const d = decks.find((x) => x.id === deckId);
  if (!d) return;
  d.art = { ...(d.art || {}), [key]: id };
  storeDecks(decks);
}
function clearDeckArt(deckId, key) {
  const decks = loadDecks();
  const d = decks.find((x) => x.id === deckId);
  if (!d || !d.art) return;
  delete d.art[key];
  if (!Object.keys(d.art).length) delete d.art;
  storeDecks(decks);
  pruneArt();
}

// Bring a saved deck to the table: upload its custom art (skipping pictures the
// server already has), then load the deck. Anything that fails to upload just
// shows Scryfall's picture.
async function bringDeck(deck, doneMsg) {
  const cards = unpackCards(deck.cards, deck.art);
  const ids = [...new Set(cards.flatMap((c) => [c.art, c.artBack]).filter(Boolean))];
  if (ids.length && app.code && app.playerId) {
    const base = `/art/${encodeURIComponent(app.code)}/${encodeURIComponent(app.playerId)}/`;
    let done = 0, failed = 0;
    const show = () => toast(`Sending your card art to the table… ${done} of ${ids.length}`);
    show();
    const queue = [...ids];
    const worker = async () => {
      while (queue.length) {
        const id = queue.shift();
        try {
          const head = await fetch(base + id, { method: 'HEAD' });
          if (!head.ok) {
            const blob = await getArt(id);
            if (!blob) throw new Error('missing');
            const res = await fetch(base + id, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
            if (!res.ok) throw new Error(String(res.status));
          }
        } catch { failed++; }
        done++;
        show();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (failed) doneMsg = `${failed} custom picture${failed === 1 ? '' : 's'} couldn't be sent, so ${failed === 1 ? 'that card shows' : 'those cards show'} the usual art. ` + (doneMsg || '');
  }
  send({ type: 'loadDeck', cards, cardBack: deck.cardBack || null });
  if (doneMsg) toast(doneMsg);
  else if (ids.length) toast('Card art sent');
}

// The card art sheet for one saved deck.
function openArtSheet(deckId, opts = {}) {
  const deck = deckById(deckId);
  if (!deck) return;
  openSheet('art', `
    <button class="btn small sheet-close" data-close>Done</button>
    <h3>Card art · ${esc(deck.name)}</h3>
    <p class="note">Use your own pictures for any card in this deck. Everyone at the table sees them. Pictures are cropped to card shape, so a full card scan works best.</p>
    <label class="art-drop" id="artDrop">
      <input type="file" accept="image/*" multiple id="artFiles" hidden>
      <span class="art-drop-well" aria-hidden="true"><span></span><span></span><span></span></span>
      <span class="art-drop-text"><b>Add many at once</b><span>Drop pictures here or tap to choose. Each file is matched to a card by its name, like <code>Lightning Bolt.jpg</code>.</span></span>
    </label>
    <p class="note art-msg" id="artMsg" role="status"></p>
    <div id="artLeft"></div>
    <div class="art-tools">
      <input id="artFind" type="search" placeholder="Find a card" autocomplete="off" value="${esc(opts.find || '')}">
      <span class="note" id="artCount"></span>
    </div>
    <div class="art-grid" id="artGrid"></div>
    <input type="file" accept="image/*" id="artOne" hidden>`, { deckId, left: [] });
  renderArtGrid();
  const drop = $('#artDrop');
  $('#artFiles').onchange = (e) => { const files = [...e.target.files]; e.target.value = ''; bulkArt(files); };
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    bulkArt([...e.dataTransfer.files].filter((f) => f.type.startsWith('image/')));
  });
  $('#artFind').oninput = () => renderArtGrid();
  // One card: tap it to choose its picture.
  let target = null;
  $('#artOne').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file || !target) return;
    const key = target;
    $('#artMsg').textContent = 'Preparing your picture…';
    try { await setDeckArt(deckId, key, file); $('#artMsg').textContent = ''; }
    catch { $('#artMsg').textContent = "That picture couldn't be used. Try a JPEG or PNG."; }
    renderArtGrid();
    renderLandingDecks();
    pruneArt(); // the picture it replaced
  };
  $('#artGrid').addEventListener('click', (e) => {
    const reset = e.target.closest('[data-art-reset]');
    if (reset) { clearDeckArt(deckId, reset.dataset.artReset); renderArtGrid(); renderLandingDecks(); return; }
    const pickBtn = e.target.closest('[data-art-pick]');
    if (!pickBtn) return;
    target = pickBtn.dataset.artPick;
    $('#artOne').click();
  });
  $('#artLeft').addEventListener('change', async (e) => {
    const sel = e.target.closest('select[data-left]');
    if (!sel || !sel.value) return;
    const i = Number(sel.dataset.left);
    const file = sheetData.left[i];
    sel.disabled = true;
    try { await setDeckArt(deckId, sel.value, file); sheetData.left[i] = null; }
    catch { $('#artMsg').textContent = `${file.name} couldn't be used. Try a JPEG or PNG.`; sel.disabled = false; }
    renderArtLeft();
    renderArtGrid();
    renderLandingDecks();
  });
}
async function renderArtGrid() {
  if (sheetKind !== 'art') return;
  const deck = deckById(sheetData.deckId);
  if (!deck) return closeSheet();
  const art = deck.art || {};
  const slots = artSlots(deck);
  const find = looseName($('#artFind').value || '');
  const shown = find ? slots.filter((s) => looseName(s.card.name).includes(find)) : slots;
  const custom = slots.filter((s) => art[s.key]).length;
  $('#artCount').textContent = custom ? `${custom} of ${slots.length} with your art` : `${slots.length} cards`;
  const small = (u) => String(u || '').replace('/normal/', '/small/');
  $('#artGrid').innerHTML = shown.map((s) => `
    <figure class="art-slot${art[s.key] ? ' custom' : ''}">
      <button type="button" class="art-card" data-art-pick="${esc(s.key)}" aria-label="Choose a picture for ${esc(s.label)}${s.second ? ' (back face)' : ''}">
        ${s.img || art[s.key] ? `<img alt="" loading="lazy" draggable="false" ${art[s.key] ? `data-art="${esc(art[s.key])}"` : `src="${esc(small(s.img))}"`}>` : `<span class="art-blank">${esc(s.label)}</span>`}
        ${s.card.back ? `<span class="art-face">${s.second ? 'Back' : 'Front'}</span>` : ''}
      </button>
      <figcaption><span class="art-name" title="${esc(s.label)}">${esc(s.label)}</span>${art[s.key] ? `<button type="button" class="link-btn" data-art-reset="${esc(s.key)}">Reset</button>` : ''}</figcaption>
    </figure>`).join('') || '<p class="muted">No cards match.</p>';
  for (const im of $('#artGrid').querySelectorAll('img[data-art]')) {
    const u = await artObjectUrl(im.dataset.art);
    if (u && im.isConnected) im.src = u;
  }
}
// Files that didn't match a card, each with a menu to pick its card by hand.
function renderArtLeft() {
  const box = $('#artLeft');
  if (!box || sheetKind !== 'art') return;
  const deck = deckById(sheetData.deckId);
  const left = sheetData.left.map((f, i) => [f, i]).filter(([f]) => f);
  if (!left.length || !deck) { box.innerHTML = ''; return; }
  const opts = artSlots(deck).map((s) => `<option value="${esc(s.key)}">${esc(s.label)}${s.card.back ? (s.second ? ' (back)' : ' (front)') : ''}</option>`).join('');
  box.innerHTML = `<div class="art-left">
    <p class="note">${left.length === 1 ? "This picture didn't" : "These pictures didn't"} match a card name. Pick the card for each:</p>
    ${left.map(([f, i]) => `<label class="art-left-row"><span class="art-file">${esc(f.name)}</span>
      <select data-left="${i}"><option value="">Choose a card…</option>${opts}</select></label>`).join('')}
  </div>`;
}
async function bulkArt(files) {
  if (!files.length || sheetKind !== 'art') return;
  const deckId = sheetData.deckId;
  const deck = deckById(deckId);
  const slots = artSlots(deck);
  const msg = $('#artMsg');
  const left = [];
  const bad = [];
  let matched = 0;
  for (const [n, f] of files.entries()) {
    msg.textContent = `Preparing ${n + 1} of ${files.length}…`;
    const slot = matchArtFile(f.name, slots);
    if (!slot) { left.push(f); continue; }
    try { await setDeckArt(deckId, slot.key, f); matched++; } catch { bad.push(f.name); }
  }
  if (sheetKind !== 'art' || sheetData.deckId !== deckId) return;
  sheetData.left = sheetData.left.filter(Boolean).concat(left);
  msg.textContent = [
    matched ? `Matched ${matched} of ${files.length} picture${files.length === 1 ? '' : 's'} to cards.` : files.length ? 'None of those file names matched a card.' : '',
    bad.length ? `Couldn't use: ${bad.join(', ')}.` : '',
  ].filter(Boolean).join(' ');
  renderArtLeft();
  renderArtGrid();
  renderLandingDecks();
  pruneArt(); // pictures that were replaced
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
  if (a === 'table') setTableView(!app.tableView);
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
      <button class="btn" data-m="table">Table view</button>
      <button class="btn" data-m="seating">Seating</button>
      <button class="btn" data-m="playmat">Playmat</button>
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
      <li>Tap Table to see everyone's playmat at once, laid out like the table. You can drag cards between any of them there.</li>
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
      if (a === 'table') { closeSheet(); return setTableView(true); }
      if (a === 'playmat') return openPlaymatSheet();
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

// ---------- Custom playmat ----------
// The picture is shrunk to a JPEG on this device, kept here for next time,
// and shared with the table so everyone sees it on your mat and edge band.
const MAT_KEY = 'ps:playmat';
function savedPlaymat() { try { return localStorage.getItem(MAT_KEY) || ''; } catch { return ''; } }
function storePlaymat(data) {
  try { if (data) localStorage.setItem(MAT_KEY, data); else localStorage.removeItem(MAT_KEY); return true; } catch { return false; }
}
function bringSavedPlaymat() {
  const m = me();
  if (!m || app.matChecked) return;
  app.matChecked = true;
  const data = savedPlaymat();
  if (data && !m.mat) send({ type: 'playmat', data });
}
async function shrinkImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = url; });
    let side = 1600;
    for (let tries = 0; tries < 8; tries++) {
      const k = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * k));
      c.height = Math.max(1, Math.round(img.naturalHeight * k));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      for (const q of [0.82, 0.7, 0.6]) {
        const data = c.toDataURL('image/jpeg', q);
        if (data.length < 300 * 1024) return data; // about 220 KB once decoded
      }
      side = Math.round(side * 0.8);
    }
    throw new Error('too big');
  } finally { URL.revokeObjectURL(url); }
}
// ---------- Custom card backs ----------
// Each saved deck can have its own card back. The picture is cropped to card
// shape and shrunk to a small JPEG on this device, saved with the deck, and
// sent to the table when the deck is loaded so everyone sees it.
// A picture cropped to fill a card (63:88), at Scryfall's card size.
async function cardCanvas(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = url; });
    const W = 488, H = 680; // Scryfall's card size, 63:88
    const k = Math.max(W / img.naturalWidth, H / img.naturalHeight);
    const sw = W / k, sh = H / k;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#000'; // transparent PNGs get a black border colour, not JPEG white
    g.fillRect(0, 0, W, H);
    g.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, 0, 0, W, H);
    return c;
  } finally { URL.revokeObjectURL(url); }
}
async function shrinkCardBack(file) {
  const c = await cardCanvas(file);
  for (const q of [0.85, 0.75, 0.65, 0.5, 0.4]) {
    const data = c.toDataURL('image/jpeg', q);
    if (data.length < 150 * 1024) return data; // about 110 KB once decoded
  }
  throw new Error('too big');
}
function showBackDraft() {
  const prev = $('.back-preview');
  if (!prev) return;
  if (app.backDraft) prev.style.setProperty('--card-back', `url("${app.backDraft}")`);
  else prev.style.removeProperty('--card-back');
  $('#backClear').hidden = !app.backDraft;
  $('#backMsg').textContent = app.backDraft
    ? "This deck's cards show this back to everyone at the table. It's cropped to card shape."
    : 'Using the official Magic card back. Choose a picture to give this deck its own.';
}
// Points an element's --card-back at the custom back of the deck this player loaded.
function backUrl(p) { return `/back/${encodeURIComponent(app.code)}/${encodeURIComponent(p.id)}?v=${p.cardBack}`; }
function setBackArt(el, p) {
  if (p && p.cardBack) el.style.setProperty('--card-back', `url("${backUrl(p)}")`);
  else el.style.removeProperty('--card-back');
}

function openPlaymatSheet() {
  const m = me();
  openSheet('playmat', `
    <button class="btn small sheet-close" data-close>Close</button>
    <h3>Your playmat</h3>
    <p class="note">Use any picture as your playmat. It's saved on this device for next time, and everyone at the table sees it on your mat.</p>
    <div class="mat-preview${m.mat ? ' has-art' : ''}" style="${m.mat ? `--mat-img:url('${matUrl(m)}')` : ''}"><span>${m.mat ? '' : 'Plain mat'}</span></div>
    <div class="row">
      <label class="btn primary">Choose a picture<input type="file" accept="image/*" id="matFile" hidden></label>
      ${m.mat ? '<button class="btn" id="matClear">Use the plain mat</button>' : ''}
    </div>
    <p class="note" id="matMsg">A wide picture works best (playmats are about 2:1). It's cropped to fill the mat.</p>`);
  $('#matFile').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    $('#matMsg').textContent = 'Preparing your picture…';
    try {
      const data = await shrinkImage(file);
      send({ type: 'playmat', data });
      const kept = storePlaymat(data);
      closeSheet();
      toast(kept ? 'Playmat set' : 'Playmat set for this session (this device is out of space to keep it)');
    } catch { $('#matMsg').textContent = "That picture couldn't be used. Try a JPEG or PNG."; }
  };
  const clear = $('#matClear');
  if (clear) clear.onclick = () => { send({ type: 'playmat', data: null }); storePlaymat(''); closeSheet(); };
}

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
