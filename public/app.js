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
    if (app.library && sheetKind === 'library') send({ type: 'searchLibrary', quiet: true });
  } else if (msg.type === 'library') {
    app.library = msg.cards;
    if (sheetKind === 'library') renderLibrarySheet();
  } else if (msg.type === 'error') {
    if (!$('#game').hidden && app.s) toast(msg.error);
    else showLanding(msg.error);
    if (!app.s) { app.code = null; app.playerId = null; }
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
  send({ type: 'create', name, startingLife: Number($('#lifeSelect').value) });
};
$('#joinBtn').onclick = () => {
  const name = $('#nameInput').value.trim();
  const code = $('#codeInput').value.trim().toUpperCase();
  if (!code) return ($('#landingError').textContent = 'Enter the 5 letter session code.');
  rememberName(name);
  let pid = null;
  try { pid = localStorage.getItem('ps:' + code); } catch {}
  send({ type: 'join', code, name, playerId: pid });
};
$('#codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#joinBtn').click(); });

function boot() {
  $('#nameInput').value = savedName();
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
// Layout (one tablet per player): opponents as compact tiles along the top,
// an optional "focused" opponent playmat in the middle, and your own playmat
// filling the rest of the screen above your hand.
function render() {
  const s = app.s;
  const mine = me();
  if (!s || !mine) return;
  const used = new Set();
  const opps = s.players.filter((p) => p !== mine).sort((a, b) => a.seat - b.seat);
  if (app.focus && !opps.some((p) => p.id === app.focus)) app.focus = null;

  // Opponent tiles, plus an invite tile while seats are free
  const strip = $('#oppStrip');
  const tiles = opps.map((p) => updateTile(tileFor(p), p));
  if (s.players.length < 4) tiles.push(inviteTile());
  syncChildren(strip, tiles);
  strip.dataset.count = tiles.length;

  // Focused opponent playmat
  const focusP = app.focus && playerById(app.focus);
  const focus = $('#focusArea');
  focus.hidden = !focusP;
  $('#table').classList.toggle('has-focus', !!focusP);
  if (focusP) {
    const mat = matFor(focusP);
    syncChildren(focus, [mat]);
    updateMat(mat, focusP, used);
  } else syncChildren(focus, []);

  // My playmat
  const myMat = matFor(mine);
  syncChildren($('#myArea'), [myMat]);
  updateMat(myMat, mine, used);

  for (const [id, mat] of app.matEls) {
    if (!playerById(id)) { mat.remove(); app.matEls.delete(id); }
  }

  // My hand
  const hand = $('#hand');
  $('#handCount').textContent = `(${mine.zones.hand.length})`;
  $('#handBar').dataset.player = mine.id;
  syncChildren(hand, mine.zones.hand.map((c) => cardEl(c, 'hand', mine, used)));
  layoutHand();

  // Drop cards we no longer show anywhere
  for (const [id, el] of app.cardEls) if (!used.has(id)) { el.remove(); app.cardEls.delete(id); }

  renderLog();
  if (sheetKind === 'pile') renderPileSheet();
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

// ---------- Opponent tiles ----------
const tileEls = new Map();
function tileFor(p) {
  let t = tileEls.get(p.id);
  if (t) return t;
  t = document.createElement('section');
  t.className = 'opp-tile';
  t.dataset.player = p.id;
  t.innerHTML = `
    <div class="opp-head">
      <span class="dot"></span><span class="nm"></span><span class="offline"></span>
      <div class="life small">
        <button data-life="-1" aria-label="Lose 1 life">−</button>
        <span class="val"></span>
        <button data-life="1" aria-label="Gain 1 life">+</button>
      </div>
    </div>
    <div class="mini-bf" data-drop="1" data-zone="battlefield" data-player="${p.id}"></div>
    <div class="opp-zones">
      <span class="zchip" data-drop="1" data-zone="hand" data-player="${p.id}"><span class="lg">Hand</span><span class="sh">Hand</span> <b data-n="hand"></b></span>
      <span class="zchip" data-drop="1" data-zone="library" data-player="${p.id}"><span class="lg">Library</span><span class="sh">Lib</span> <b data-n="library"></b></span>
      <span class="zchip" data-drop="1" data-zone="graveyard" data-player="${p.id}" data-open="graveyard"><span class="lg">Graveyard</span><span class="sh">GY</span> <b data-n="graveyard"></b></span>
      <span class="zchip" data-drop="1" data-zone="exile" data-player="${p.id}" data-open="exile"><span class="lg">Exile</span><span class="sh">Exile</span> <b data-n="exile"></b></span>
    </div>`;
  t.querySelectorAll('[data-life]').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); send({ type: 'life', playerId: p.id, delta: Number(b.dataset.life) }); };
  });
  t.addEventListener('click', (e) => {
    if (drag || e.target.closest('button')) return;
    const chip = e.target.closest('[data-open]');
    if (chip) return openPileSheet(p.id, chip.dataset.open);
    setFocus(p.id);
  });
  tileEls.set(p.id, t);
  return t;
}

function updateTile(t, p) {
  t.style.setProperty('--seat', p.color);
  t.classList.toggle('focused', app.focus === p.id);
  $('.nm', t).textContent = p.name;
  $('.offline', t).textContent = p.connected ? '' : 'offline';
  const lv = $('.val', t);
  lv.textContent = p.life;
  lv.classList.toggle('low', p.life <= 5);
  for (const z of ['hand', 'library', 'graveyard', 'exile']) $(`[data-n="${z}"]`, t).textContent = p.counts[z];
  // Miniature battlefield: small, non-interactive copies of the cards
  const mini = $('.mini-bf', t);
  mini.dataset.empty = p.zones.battlefield.length ? '' : 'Drop cards here';
  mini.innerHTML = p.zones.battlefield.map((c) => {
    const hidden = !c.name || c.faceDown;
    const src = c.transformed && c.back ? c.back : c.img;
    return `<div class="mini-card${hidden ? ' back' : ''}${c.tapped ? ' tapped' : ''}" style="left:${(c.x * 100).toFixed(1)}%;top:${(c.y * 100).toFixed(1)}%">${!hidden && src ? `<img src="${esc(src)}" alt="">` : ''}</div>`;
  }).join('');
  return t;
}

let inviteEl = null;
function inviteTile() {
  if (!inviteEl) {
    inviteEl = document.createElement('section');
    inviteEl.className = 'opp-tile invite';
    inviteEl.innerHTML = `<div class="invite-inner"><span class="muted">Waiting for players</span><b class="invite-code"></b><span class="muted small-note">Enter this code on another tablet, or tap to share the link</span></div>`;
    inviteEl.onclick = () => $('#inviteBtn').click();
  }
  $('.invite-code', inviteEl).textContent = app.code;
  return inviteEl;
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
  if (d.started) finishDrag(d, e.clientX, e.clientY);
  else onClick(d);
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
  autoScroll();
}

function autoScroll() {
  if (!drag || !drag.started) return;
  const table = $('#table');
  const r = table.getBoundingClientRect();
  const edge = 56;
  if (drag.y < r.top + edge) table.scrollTop -= 14;
  else if (drag.y > r.bottom - edge && drag.y < r.bottom + 4) table.scrollTop += 14;
  requestAnimationFrame(autoScroll);
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

function finishDrag(d, x, y) {
  const target = dropTargetAt(x, y);
  cleanupDrag(d);
  if (!target) return;
  const toZone = target.dataset.zone;
  const toPlayer = target.dataset.player;
  const msg = { type: 'move', cardId: d.id, toPlayer, toZone };
  if (toZone === 'battlefield') {
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

function openDeckSheet() {
  let saved = '';
  try { saved = localStorage.getItem('ps:deck') || ''; } catch {}
  openSheet('deck', `
    <button class="btn small sheet-close" data-close>Close</button>
    <h3>Load a deck</h3>
    <p class="note">Paste a deck list, one card per line, like <code>4 Lightning Bolt</code>. Export from Moxfield, Archidekt, MTG Arena, MTGO and most other deckbuilders works ("Export → Text"). Lines under a <code>Sideboard</code> heading are skipped. Cards under a <code>Commander</code> heading start on your battlefield.</p>
    <textarea id="deckText" spellcheck="false" placeholder="4 Lightning Bolt&#10;20 Mountain">${esc(saved)}</textarea>
    <div class="row">
      <button class="btn primary" id="deckLoad">Load deck</button>
      <button class="btn" id="deckSample">Use sample deck</button>
      <span id="deckStatus" class="note"></span>
    </div>
    <div class="guess">Loading a deck replaces all of your current cards, wherever they are on the table, and shuffles them into your library. Deckbuilder links aren't supported yet; paste the exported list.</div>`);
  $('#deckSample').onclick = () => { $('#deckText').value = SAMPLE_DECK; };
  $('#deckLoad').onclick = () => importDeck($('#deckText').value);
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

async function importDeck(text) {
  const status = $('#deckStatus');
  const entries = parseDeck(text);
  if (!entries.length) return (status.textContent = 'No cards found in that list.');
  try { localStorage.setItem('ps:deck', text); } catch {}
  $('#deckLoad').disabled = true;
  status.textContent = 'Looking up cards on Scryfall…';
  const notFound = [];
  const resolved = new Map(); // entry index -> scryfall card
  try {
    // Scryfall accepts up to 75 identifiers per request.
    for (let i = 0; i < entries.length; i += 75) {
      const chunk = entries.slice(i, i + 75);
      const ids = chunk.map((e) => (e.set && e.num ? { set: e.set, collector_number: e.num } : { name: e.name.split(' // ')[0] }));
      const data = await scryfallCollection(ids);
      const found = data.data || [];
      // Results come back in request order with missing ones skipped; match them back up.
      let fi = 0;
      chunk.forEach((e, j) => {
        const card = found[fi];
        const want = ids[j];
        const matches = card && (want.name
          ? card.name.toLowerCase() === want.name.toLowerCase() || card.name.toLowerCase().startsWith(want.name.toLowerCase() + ' //')
          : card.set === want.set && String(card.collector_number) === String(want.collector_number));
        if (matches) { resolved.set(i + j, card); fi++; }
        else if (want.set) {
          // Set/number not found: retry by name below.
          e.set = null; e.num = null;
          e.retry = true;
        } else notFound.push(e.name);
      });
      if (i + 75 < entries.length) await new Promise((r) => setTimeout(r, 550));
    }
    const retry = entries.map((e, i) => [e, i]).filter(([e]) => e.retry);
    for (let i = 0; i < retry.length; i += 75) {
      const chunk = retry.slice(i, i + 75);
      const data = await scryfallCollection(chunk.map(([e]) => ({ name: e.name.split(' // ')[0] })));
      const byName = new Map((data.data || []).map((c) => [c.name.toLowerCase(), c]));
      for (const [e, idx] of chunk) {
        const n = e.name.toLowerCase();
        const card = byName.get(n) || [...byName.values()].find((c) => c.name.toLowerCase().startsWith(n.split(' // ')[0] + ' //'));
        if (card) resolved.set(idx, card); else notFound.push(e.name);
      }
    }
  } catch (err) {
    $('#deckLoad').disabled = false;
    status.textContent = 'Could not reach Scryfall (' + err.message + '). Check your connection and try again.';
    return;
  }
  const cards = [];
  entries.forEach((e, i) => {
    const sc = resolved.get(i);
    if (!sc) return;
    const im = imagesOf(sc);
    for (let k = 0; k < e.qty; k++) cards.push({ name: sc.name, img: im.img, back: im.back, commander: e.commander });
  });
  $('#deckLoad').disabled = false;
  if (!cards.length) return (status.textContent = 'None of those cards were found on Scryfall.');
  send({ type: 'loadDeck', cards });
  if (notFound.length) {
    status.textContent = `Loaded ${cards.length} cards. Not found: ${notFound.join(', ')}`;
  } else {
    closeSheet();
    toast(`Loaded ${cards.length} cards and shuffled. Tap your library to draw.`);
  }
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
      <button class="btn" data-m="untap">Untap all</button>
      <button class="btn" data-m="shuffle">Shuffle library</button>
      <button class="btn" data-m="new">Reset my cards (new game)</button>
      <button class="btn" data-m="rename">Change my name</button>
      <button class="btn danger" data-m="leave">Leave session</button>
    </div>
    <div id="moreExtra"></div>
    <h3 style="margin-top:14px">How to play here</h3>
    <ul class="note">
      <li>Drag any card to any zone on any playmat. Drop onto an opponent's tile to give them the card. You can also tap or long-press a card for a menu with every move.</li>
      <li>Tap an opponent's tile to open their full playmat above yours. Tap it again (or Close) to put it away.</li>
      <li>Click or tap a card on the battlefield to tap / untap it. Right-click or long-press for more.</li>
      <li>Tap your library to draw. Drag it to move the top card somewhere.</li>
      <li>Anyone can change anyone's life total with − and +.</li>
      <li>A coloured dot on a card means it belongs to the player of that colour.</li>
    </ul>`);
  $('#sheet').querySelectorAll('[data-m]').forEach((b) => {
    b.onclick = () => {
      const a = b.dataset.m;
      const extra = $('#moreExtra');
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
  const TAPPABLE = 'button, .opp-tile, .pile:not(.mine), .zchip, .chip';
  let down = null;
  let synth = false;
  let swallowUntil = 0;
  document.addEventListener('pointerdown', (e) => {
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
    synth = true;
    try { d.target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); } finally { synth = false; }
  }, true);
  document.addEventListener('pointercancel', () => { down = null; }, true);
  document.addEventListener('click', (e) => {
    if (!synth && Date.now() < swallowUntil) { e.stopImmediatePropagation(); e.preventDefault(); }
  }, true);
})();
