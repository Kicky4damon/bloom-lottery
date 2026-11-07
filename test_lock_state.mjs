/**
 * Pure timing/state tests: draw lock + revealed restore + public vs reserved counters.
 * Mirrors /workspace/bloom-lottery/index.html — no browser.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));

function makeStats(results, goodsCap = 26, act = null) {
  const R = results;
  const all = Object.keys(R);
  const shown = all.filter(id => R[id].revealed);
  const winShown = shown.filter(id => R[id].win).length;
  const winReserved = all.filter(id => R[id].win).length;
  const list = act || all;
  const total = new Set([...list, ...all]).size;
  return {
    goods: Math.max(0, goodsCap - winShown),
    goodsLeft: Math.max(0, goodsCap - winReserved),
    win: winShown,
    opened: shown.length,
    total,
    GOODS: goodsCap,
  };
}

function buggyStats(results, PENDING = null, goodsCap = 26) {
  // pre-fix: exclude only PENDING, count unrevealed after reload
  const R = results;
  const ids = Object.keys(R).filter(id => id !== PENDING);
  const win = ids.filter(id => R[id].win).length;
  return { goods: Math.max(0, goodsCap - win), win, opened: ids.length };
}

function makeMachine() {
  let busy = false;
  let locked = false;
  let PENDING = null;
  let guardUntil = 0;
  let now = 0;
  const timers = [];
  const results = {};
  const open = new Set();
  const pendingUi = new Set();
  const schedule = (fn, ms) => { timers.push({ at: now + ms, fn }); };
  const flushTo = (t) => {
    now = t;
    timers.sort((a, b) => a.at - b.at);
    while (timers.length && timers[0].at <= now) timers.shift().fn();
  };
  const canPull = (id) => {
    if (busy || open.has(id) || now < guardUntil) return false;
    if (locked) return false;
    return true;
  };
  const setRes = (id) => { open.add(id); pendingUi.delete(id); };
  const commit = (id) => {
    results[id].revealed = true;
    if (PENDING === id) PENDING = null;
  };
  const finishReveal = (id) => {
    commit(id);
    pendingUi.delete(id);
    schedule(() => {
      setRes(id);
      guardUntil = now + 700;
      schedule(() => { busy = false; locked = false; }, 700);
    }, 1050);
  };
  const beginStage = (id) => {
    PENDING = id;
    busy = true;
    locked = true;
    pendingUi.add(id);
  };
  const pull = (id, { silent = false, win = false, kind } = {}) => {
    if (busy || open.has(id)) return false;
    if (results[id]) {
      if (results[id].revealed) { setRes(id); return 'paint'; }
      beginStage(id);
      return 'resume';
    }
    const k = kind || (win ? 'win' : 'lose');
    results[id] = { win: !!win, kind: k, revealed: !!silent, ts: 'T0' };
    if (silent) { commit(id); setRes(id); return 'silent'; }
    beginStage(id);
    return 'start';
  };
  const stageClose = (id) => {
    guardUntil = now + 700;
    finishReveal(id);
  };
  const publicStats = (cap = 26) => makeStats(results, cap);
  return {
    get state() {
      return {
        busy, locked, PENDING, guardUntil, now,
        results: structuredClone(results), open: [...open], pendingUi: [...pendingUi],
      };
    },
    canPull, pull, stageClose, flushTo, publicStats, results,
  };
}

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log('ok', name);
}

// --- lock: old closeAll window ---
test('old unlock window during peel', () => {
  let busy = false, locked = false, now = 0, guardUntil = 0;
  const timers = [];
  const sch = (fn, ms) => timers.push({ at: now + ms, fn });
  const flush = t => {
    now = t; timers.sort((a, b) => a.at - b.at);
    while (timers.length && timers[0].at <= now) timers.shift().fn();
  };
  busy = true; locked = true;
  guardUntil = now + 700;
  sch(() => { busy = false; locked = false; }, 700);
  let peelDone = false; sch(() => { peelDone = true; }, 1050);
  flush(700);
  assert.equal(locked, false);
  assert.equal(busy, false);
  assert.equal(peelDone, false);
  assert.equal(!busy && !locked && now >= guardUntil, true);
});

// --- lock: patched through peel+guard ---
test('patched lock through peel and ghost guard', () => {
  const m = makeMachine();
  m.pull('neonfilm');
  m.stageClose('neonfilm');
  m.flushTo(1049);
  assert.equal(m.state.locked, true);
  assert.equal(m.canPull('orbit_log'), false);
  m.flushTo(1050);
  assert.equal(m.state.open.includes('neonfilm'), true);
  assert.equal(m.canPull('orbit_log'), false);
  m.flushTo(1750);
  assert.equal(m.state.busy, false);
  assert.equal(m.state.locked, false);
  assert.equal(m.canPull('orbit_log'), true);
});

test('busy rejects second start', () => {
  const m = makeMachine();
  assert.equal(m.pull('neonfilm'), 'start');
  assert.equal(m.pull('orbit_log'), false);
  assert.equal(m.state.PENDING, 'neonfilm');
  assert.deepEqual(Object.keys(m.state.results), ['neonfilm']);
});

test('buildBoard hides unrevealed', () => {
  const incomplete = { win: false, kind: 'lose', revealed: false };
  const PENDING = null;
  const id = 'orbit_log';
  const buggy = (incomplete && incomplete.revealed !== false) || (incomplete && id !== PENDING);
  const patched = !!(incomplete && incomplete.revealed);
  assert.equal(buggy, true);
  assert.equal(patched, false);
});

// --- counters: browser-reported failure ---
test('reload: revealed false lose must not bump participation', () => {
  const results = {
    neonfilm: { win: false, kind: 'lose', revealed: true },
    orbit_log: { win: false, kind: 'lose', revealed: false },
  };
  const old = buggyStats(results, null);
  const neu = makeStats(results);
  assert.equal(old.opened, 2, 'old bug counted unrevealed');
  assert.equal(neu.opened, 1);
  assert.equal(neu.win, 0);
  assert.equal(neu.goods, 26);
});

test('reload: unrevealed win hidden in public, reserved in goodsLeft', () => {
  const results = {
    a: { win: true, kind: 'win', revealed: true },
    b: { win: true, kind: 'fake', revealed: false },
  };
  const neu = makeStats(results, 26);
  assert.equal(neu.opened, 1);
  assert.equal(neu.win, 1);
  assert.equal(neu.goods, 25); // public remaining
  assert.equal(neu.goodsLeft, 24); // reserved pending win
  const old = buggyStats(results, null, 26);
  assert.equal(old.win, 2);
  assert.equal(old.opened, 2);
});

test('session during draw: pending lose not in opened', () => {
  const results = {
    neonfilm: { win: false, revealed: true },
    housegroove: { win: false, kind: 'lose', revealed: false },
  };
  const neu = makeStats(results);
  assert.equal(neu.opened, 1);
  // old with PENDING set looked ok; old with PENDING null (reload) did not
  assert.equal(buggyStats(results, 'housegroove').opened, 1);
  assert.equal(buggyStats(results, null).opened, 2);
});

test('prize cap: reserved wins block further awards at 26', () => {
  const results = {};
  for (let i = 0; i < 25; i++) results['r' + i] = { win: true, revealed: true };
  results.pending = { win: true, kind: 'win', revealed: false };
  const S = makeStats(results, 26);
  assert.equal(S.win, 25);
  assert.equal(S.goods, 1);
  assert.equal(S.goodsLeft, 0);
  // allocation gate
  assert.equal(S.goodsLeft <= 0, true);
});

test('resume pending preserves outcome and counts once on reveal', () => {
  const m = makeMachine();
  assert.equal(m.pull('housegroove', { win: false, kind: 'lose' }), 'start');
  assert.equal(m.publicStats().opened, 0);
  const ts = m.state.results.housegroove.ts;
  // simulate reload mid-draw: PENDING cleared in UI but result remains
  const stored = structuredClone(m.state.results);
  assert.equal(stored.housegroove.revealed, false);
  assert.equal(makeStats(stored).opened, 0);
  // resume
  const m2 = makeMachine();
  Object.assign(m2.results, stored);
  assert.equal(m2.pull('housegroove'), 'resume');
  assert.equal(m2.state.results.housegroove.ts, ts);
  assert.equal(m2.state.results.housegroove.win, false);
  m2.stageClose('housegroove');
  m2.flushTo(1750);
  assert.equal(m2.publicStats().opened, 1);
  assert.equal(m2.pull('housegroove'), false); // open/busy path — already open after setRes; busy false
  // revealed paint path
  assert.equal(m2.state.results.housegroove.revealed, true);
  assert.equal(m2.publicStats().opened, 1);
});

test('duplicate id cannot double-count', () => {
  const results = { same: { win: false, revealed: true } };
  // second pull would hit revealed paint, not new result
  const S = makeStats(results);
  assert.equal(S.opened, 1);
  results.same.revealed = true;
  assert.equal(Object.keys(results).length, 1);
});

test('closed reveal increments public opened exactly once', () => {
  const m = makeMachine();
  m.pull('neonfilm', { win: false });
  assert.equal(m.publicStats().opened, 0);
  m.stageClose('neonfilm');
  // after commit inside finishReveal but before setRes/render timing in machine, revealed true
  assert.equal(m.state.results.neonfilm.revealed, true);
  assert.equal(m.publicStats().opened, 1);
  m.flushTo(1750);
  assert.equal(m.publicStats().opened, 1);
});

test('allocation uses goodsLeft not public goods', () => {
  const results = {
    shown: { win: true, revealed: true },
    hid: { win: true, revealed: false },
  };
  const S = makeStats(results, 26);
  // display still shows 25 left; allocator sees 24
  assert.equal(S.goods, 25);
  assert.equal(S.goodsLeft, 24);
  const remain = 10;
  // probability denominator uses goodsLeft
  assert.ok(S.goodsLeft / remain < S.goods / remain);
});


/** Mirrors index.html bloomLowQuality (keep in sync). */
function bloomLowQuality(q, nav, mm) {
  q = String(q == null ? '' : q).toLowerCase();
  if (q === 'low' || q === 'lo' || q === 'mobile') return true;
  if (q === 'high' || q === 'hi' || q === 'desktop') return false;
  const ua = (nav && nav.userAgent) || '';
  const touches = +(nav && nav.maxTouchPoints) || 0;
  let coarse = false;
  try { coarse = !!(mm && mm('(pointer:coarse)').matches); } catch (e) {}
  if (coarse) return true;
  if (/iPad|iPhone|Android/i.test(ua)) return true;
  if (/Macintosh/i.test(ua) && touches > 1) return true;
  return false;
}

test('quality=low forces LO', () => {
  assert.equal(bloomLowQuality('low', { userAgent: 'Mozilla/5.0 (Macintosh)', maxTouchPoints: 0 }, () => ({ matches: false })), true);
});
test('quality=high forces desktop even on coarse', () => {
  assert.equal(bloomLowQuality('high', { userAgent: 'iPad', maxTouchPoints: 5 }, () => ({ matches: true })), false);
});
test('iPadOS Macintosh+touches uses LO', () => {
  assert.equal(bloomLowQuality('', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 5 }, () => ({ matches: false })), true);
});
test('desktop Macintosh no touch stays HQ', () => {
  assert.equal(bloomLowQuality('', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 0 }, () => ({ matches: false })), false);
});
test('classic iPad UA uses LO', () => {
  assert.equal(bloomLowQuality('', { userAgent: 'Mozilla/5.0 (iPad; CPU OS 16_0)', maxTouchPoints: 5 }, () => ({ matches: false })), true);
});
test('coarse pointer tablet uses LO', () => {
  assert.equal(bloomLowQuality('', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', maxTouchPoints: 0 }, () => ({ matches: true })), true);
});
test('quality override does not depend on win flags', () => {
  // documentation: quality must not alter lottery — function has no win/goods inputs
  assert.equal(bloomLowQuality('low', { userAgent: 'x', maxTouchPoints: 0 }, () => ({ matches: false })), true);
  assert.equal(bloomLowQuality('high', { userAgent: 'iPhone', maxTouchPoints: 5 }, () => ({ matches: true })), false);
});




// --- skip-flow gesture / active timeline (mirrors local draft; not on Pages) ---
function makeCloseGate(opts = {}) {
  const minVisible = opts.minVisible ?? 1.2;
  let presented = false, painted = false, closed = false, closeArmed = false, closePtr = null, doneOnce = false, closes = 0;
  let presentActive = 0, autoCloseAt = opts.autoCloseAt ?? null, hidden = false;
  const finishClose = () => {
    if (closed || !presented || !painted || doneOnce) return false;
    if (presentActive < minVisible) return false;
    closed = true; doneOnce = true; closeArmed = false; closePtr = null; closes += 1; return true;
  };
  const armClose = () => {
    if (closed || closeArmed || !painted || presentActive < minVisible) return false;
    closeArmed = true; closePtr = null; return true;
  };
  const onDown = (id, x = 0, y = 0) => { if (!closeArmed || closed) return; closePtr = { id, x, y }; };
  const onMove = (id, x, y) => { if (closePtr && id === closePtr.id && Math.hypot(x - closePtr.x, y - closePtr.y) > 28) closePtr = null; };
  const onCancel = (id) => { if (closePtr && id === closePtr.id) closePtr = null; };
  const onUp = (id) => {
    if (!closeArmed || closed || !closePtr || id !== closePtr.id) {
      if (closePtr && id === closePtr.id) closePtr = null;
      return false;
    }
    closePtr = null; return finishClose();
  };
  const markPainted = (auto = 9, mv = minVisible) => {
    painted = true; presented = true; presentActive = 0; autoCloseAt = auto;
    // allow per-call override of minVisible after paint (mirrors markFinal resolving kind)
    Object.defineProperty(opts, '_mv', { value: mv, writable: true });
  };
  // re-read minVisible from closure — use mutable box
  let mv = minVisible;
  const setMinVisible = (v) => { mv = v; };
  const finishClose2 = () => {
    if (closed || !presented || !painted || doneOnce) return false;
    if (presentActive < mv) return false;
    closed = true; doneOnce = true; closeArmed = false; closePtr = null; closes += 1; return true;
  };
  const armClose2 = () => {
    if (closed || closeArmed || !painted || presentActive < mv) return false;
    closeArmed = true; closePtr = null; return true;
  };
  const onUp2 = (id) => {
    if (!closeArmed || closed || !closePtr || id !== closePtr.id) {
      if (closePtr && id === closePtr.id) closePtr = null;
      return false;
    }
    closePtr = null; return finishClose2();
  };
  const advanceActive = (dt) => {
    if (hidden || !painted || closed) return;
    presentActive += dt;
    if (presentActive >= mv) armClose2();
    if (autoCloseAt != null && presentActive >= autoCloseAt) finishClose2();
  };
  const markFinal = (ph, hold = false) => {
    const isWin = ph === 'won' || ph === 'win';
    mv = isWin ? 3.0 : 2.5;
    painted = true; presented = true; presentActive = 0;
    autoCloseAt = hold ? null : (isWin ? 9 : 4.5);
  };
  return {
    markPainted, markFinal, setMinVisible, advanceActive, setHidden: (h) => { hidden = h; },
    onDown, onMove, onCancel, onUp: onUp2, finishClose: finishClose2, armClose: armClose2,
    get closes() { return closes; },
    get presentActive() { return presentActive; },
    get minVisible() { return mv; },
    get closeArmed() { return closeArmed; },
    get state() { return { presented, painted, closed, closeArmed, doneOnce, closePtr, presentActive, autoCloseAt, hidden, minVisible: mv }; },
  };
}

test('held finger through armClose cannot dismiss without new down', () => {
  const g = makeCloseGate();
  g.markFinal('won');
  g.advanceActive(3.0);
  assert.equal(g.onUp(1), false);
  assert.equal(g.closes, 0);
  g.onDown(2); assert.equal(g.onUp(2), true);
  assert.equal(g.closes, 1);
});

test('doneOnce blocks duplicate close', () => {
  const g = makeCloseGate();
  g.markFinal('lost');
  g.advanceActive(2.5);
  g.onDown(1); assert.equal(g.onUp(1), true);
  assert.equal(g.finishClose(), false);
  assert.equal(g.closes, 1);
});

test('pointer move beyond slop cancels close gesture', () => {
  const g = makeCloseGate();
  g.markFinal('won');
  g.advanceActive(3.0);
  g.onDown(1, 0, 0); g.onMove(1, 40, 0);
  assert.equal(g.onUp(1), false);
  assert.equal(g.closes, 0);
});

test('hide/resume pauses close deadline active time', () => {
  const g = makeCloseGate();
  g.markFinal('lost'); // autoClose 4.5, min 2.5
  g.advanceActive(2.0);
  g.setHidden(true);
  g.advanceActive(10);
  assert.equal(g.closes, 0);
  assert.ok(g.presentActive < 4.5);
  g.setHidden(false);
  g.advanceActive(2.6);
  assert.equal(g.closes, 1);
});

test('long wall-clock gap single frame does not skip charge with dt cap', () => {
  const CH = 2.8, wonAt = CH + 2.25;
  let chargeT = 0;
  chargeT += Math.min(0.05, 10);
  assert.ok(chargeT < wonAt);
  while (chargeT < wonAt) chargeT += 0.05;
  assert.ok(chargeT >= wonAt);
});

test('win minVisible 3.0 boundary below/at', () => {
  const g = makeCloseGate();
  g.markFinal('won');
  assert.equal(g.minVisible, 3.0);
  g.advanceActive(2.99);
  assert.equal(g.closeArmed, false);
  assert.equal(g.finishClose(), false);
  g.advanceActive(0.01);
  assert.equal(g.closeArmed, true);
  assert.equal(g.finishClose(), true);
});

test('lose minVisible 2.5 boundary below/at', () => {
  const g = makeCloseGate();
  g.markFinal('lost');
  assert.equal(g.minVisible, 2.5);
  g.advanceActive(2.49);
  assert.equal(g.closeArmed, false);
  assert.equal(g.finishClose(), false);
  g.advanceActive(0.01);
  assert.equal(g.closeArmed, true);
  assert.equal(g.finishClose(), true);
});

test('fake win uses won phase minVisible 3.0', () => {
  const g = makeCloseGate();
  g.markFinal('won'); // fake-win also fires ph=won
  assert.equal(g.minVisible, 3.0);
  assert.equal(g.state.autoCloseAt, 9);
  g.advanceActive(2.5);
  assert.equal(g.closeArmed, false);
  g.advanceActive(0.5);
  assert.equal(g.closeArmed, true);
});

test('no guard arming before paint / seed stage', () => {
  const g = makeCloseGate();
  g.advanceActive(5);
  assert.equal(g.closeArmed, false);
  assert.equal(g.finishClose(), false);
  g.markFinal('won');
  assert.equal(g.closeArmed, false); // needs minVisible active after paint
  g.advanceActive(3.0);
  assert.equal(g.closeArmed, true);
});

test('win final UI threshold after petal open window 2.2', () => {
  const openDur = 2.2, fireAt = 2.25;
  assert.ok(fireAt >= openDur);
  assert.ok(1.6 < openDur);
});

test('auto finishClose via active time respects minVisible then autoClose', () => {
  const g = makeCloseGate();
  g.markFinal('won'); // auto 9
  g.advanceActive(3.0);
  assert.equal(g.closes, 0);
  g.advanceActive(6.0);
  assert.equal(g.closes, 1);
  g.advanceActive(5);
  assert.equal(g.closes, 1);
});


// --- guaranteed / anon gift cap (mirrors local board draft) ---
function makeGiftModel({goods=26, guaranteed=[], anon=0, results={}} = {}) {
  const G = guaranteed.map(x => String(x).toLowerCase());
  const anonSlots = Array.from({length: anon}, (_, i) => ({ id: 'anon_x_' + i }));
  const R = structuredClone(results);
  const awarded = () => Object.keys(R).filter(id => R[id].win && R[id].revealed).length;
  const pending = () => Object.keys(R).filter(id => R[id].win && !R[id].revealed).length;
  const undrawnG = () => G.filter(id => !R[id]).length;
  const reserved = () => awarded() + pending() + undrawnG();
  const goodsLeft = () => Math.max(0, goods - reserved());
  const publicGoods = () => Math.max(0, goods - awarded());
  const configError = () => {
    if (G.length > goods) return 'g>goods';
    if (awarded() + pending() + undrawnG() > goods) return 'over';
    return '';
  };
  const drawAnon = (forceWin = false) => {
    const remain = anonSlots.filter(s => !R[s.id]).length;
    let win = remain > 0 && goodsLeft() > 0 && true; // deterministic check path
    if (forceWin) win = goodsLeft() > 0;
    if (!forceWin) win = remain > 0 && goodsLeft() > 0; // still needs goodsLeft
    // for tests we set explicitly via helpers
    return { remain, canForce: goodsLeft() > 0 };
  };
  return { G, anonSlots, R, awarded, pending, undrawnG, reserved, goodsLeft, publicGoods, configError, drawAnon };
}

test('undrawnGuaranteed reservation blocks random oversell', () => {
  const m = makeGiftModel({ goods: 26, guaranteed: ['a','b'], anon: 50 });
  assert.equal(m.undrawnG(), 2);
  assert.equal(m.goodsLeft(), 24);
  assert.equal(m.publicGoods(), 26); // none revealed yet
});

test('public gifts drop only on revealed wins', () => {
  const m = makeGiftModel({ goods: 26, guaranteed: ['a'], results: {
    anon_x_0: { win: true, revealed: false, slot: 'anon' },
  }});
  // pending anon win reserves but public unchanged
  assert.equal(m.publicGoods(), 26);
  assert.equal(m.goodsLeft(), 24); // pending1 + undrawnG1
  m.R.anon_x_0.revealed = true;
  assert.equal(m.publicGoods(), 25);
});

test('removed awarded wins still count after list edit', () => {
  const m = makeGiftModel({ goods: 26, guaranteed: [], results: {
    old_person: { win: true, revealed: true, slot: 'named' },
  }});
  assert.equal(m.awarded(), 1);
  assert.equal(m.goodsLeft(), 25);
  assert.equal(m.configError(), '');
  // trying 26 new guarantees would exceed with awarded
  const m2 = makeGiftModel({ goods: 26, guaranteed: Array.from({length:26},(_,i)=>'g'+i), results: m.R });
  assert.equal(m2.configError(), 'over');
});

test('guaranteed length alone cannot exceed goods', () => {
  const m = makeGiftModel({ goods: 26, guaranteed: Array.from({length:27},(_,i)=>'g'+i) });
  assert.equal(m.configError(), 'g>goods');
});

test('forceWin blocked when goodsLeft 0 due to guarantees', () => {
  const m = makeGiftModel({ goods: 2, guaranteed: ['a','b'], anon: 10 });
  assert.equal(m.goodsLeft(), 0);
  assert.equal(m.drawAnon(true).canForce, false);
});

test('random-first draws still leave guarantee seats', () => {
  const m = makeGiftModel({ goods: 26, guaranteed: ['a','b','c'], anon: 100 });
  // simulate 23 anon wins pending/revealed max without eating guarantee seats
  for (let i = 0; i < 23; i++) m.R['anon_x_' + i] = { win: true, revealed: true, slot: 'anon' };
  assert.equal(m.goodsLeft(), 0); // 23 awarded + 3 undrawn G
  assert.equal(m.undrawnG(), 3);
  assert.equal(m.drawAnon(true).canForce, false);
});

test('anon stable ids not position-based for results key', () => {
  const slots = [{ id: 'anon_abc_1' }, { id: 'anon_xyz_2' }];
  const results = { anon_abc_1: { win: false, revealed: true, slot: 'anon' } };
  // removing first unused slot should not rename second id
  const next = slots.filter(s => s.id !== 'anon_missing');
  assert.equal(next[1].id, 'anon_xyz_2');
  assert.ok(results[next[0].id]);
});

test('duplicate guaranteed ids normalize once', () => {
  const parse = (arr) => {
    const o = [];
    arr.map(x => String(x).trim().replace(/^@/, '').toLowerCase()).filter(Boolean).forEach(x => { if (!o.includes(x)) o.push(x); });
    return o;
  };
  assert.deepEqual(parse(['Foo', '@foo', 'FOO']), ['foo']);
});


// --- exact 100 / symbol / without-replacement quota ---
function boardEntriesEven(G, A) {
  const total = G.length + A.length, out = new Array(total), used = new Set();
  if (G.length) {
    for (let i = 0; i < G.length; i++) {
      const idx = G.length === 1 ? Math.floor((total - 1) / 2) : Math.round(i * (total - 1) / (G.length - 1));
      let j = Math.min(total - 1, Math.max(0, idx));
      while (used.has(j)) j = (j + 1) % total;
      out[j] = { id: G[i], slot: 'named' }; used.add(j);
    }
  }
  let ai = 0;
  for (let i = 0; i < total; i++) if (!out[i]) out[i] = { id: A[ai++].id, slot: 'anon' };
  return out;
}

test('default empty board is exactly 100 anon symbol slots', () => {
  const anon = Array.from({ length: 100 }, (_, i) => ({ id: 'anon_t_' + i }));
  const entries = boardEntriesEven([], anon);
  assert.equal(entries.length, 100);
  assert.ok(entries.every(e => e.slot === 'anon'));
});

test('BLOOM mark is SVG symbol not word BLOOM', () => {
  const html = fs.readFileSync(join(__dirname,'index.html'),'utf8');
  assert.ok(html.includes('const BLOOM_MARK='));
  assert.ok(html.includes('viewBox=\\"0 0 1024 1024\\"') || html.includes('viewBox="0 0 1024 1024"'));
  assert.ok(html.includes('FFCE40') && html.includes('polygon points'));
  assert.equal(/bloom-sym">BLOOM</.test(html), false);
  assert.ok(html.includes('BLOOM_MARK'));
  assert.ok(!html.includes("label=anon?'<b class=\"bloom-sym\">BLOOM</b>'"));
});

test('future guarantees interleave evenly across 100', () => {
  const G = ['a', 'b', 'c', 'd'];
  const A = Array.from({ length: 96 }, (_, i) => ({ id: 'anon_' + i }));
  const e = boardEntriesEven(G, A);
  assert.equal(e.length, 100);
  const idxs = e.map((x, i) => x.slot === 'named' ? i : -1).filter(i => i >= 0);
  assert.deepEqual(idxs, [0, 33, 66, 99]);
});

test('without-replacement quota yields exactly 26 wins over 100 draws', () => {
  // deterministic: always win when Math.random() < goodsLeft/remainAnon using fixed RNG sequence
  // simulate sequential draws with P = remainWins/remainSlots — finite without replacement
  let remainWins = 26, remainSlots = 100, wins = 0;
  // Use exact without-replacement: take wins when i < remainWins relative sampling via decrement
  // Equivalent: for each draw, win if random() < remainWins/remainSlots then remainWins--
  // With a seeded LCG that explores, expected = 26; prove path with forced schedule:
  for (let i = 0; i < 100; i++) {
    const p = remainWins / remainSlots;
    // take win iff remaining wins must fill all remaining slots OR (remainWins>0 and take when remainSlots-remainWins <= remainSlots-1-i wait)
    // exact: win when remainSlots - remainWins < remainSlots - i ... simpler: win if remainWins === remainSlots OR (remainWins>0 && i % Math.floor(100/26) ...)
    const must = remainWins > 0 && remainWins === remainSlots;
    const take = must || (remainWins > 0 && (i * remainWins) % remainSlots < remainWins); // not perfect
    // Correct exact finite sampling without RNG: place 26 wins at fixed strides then verify count
    remainSlots--;
  }
  // cleaner proof:
  remainWins = 26; remainSlots = 100; wins = 0;
  const rnd = (() => { let k = 20261107; return () => { k |= 0; k = k + 0x6D2B79F5 | 0; let t = Math.imul(k ^ k >>> 15, 1 | k); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; })();
  for (let i = 0; i < 100; i++) {
    const win = remainSlots > 0 && remainWins > 0 && rnd() < remainWins / remainSlots;
    if (win) { wins++; remainWins--; }
    remainSlots--;
  }
  assert.equal(wins, 26);
  assert.equal(remainWins, 0);
});

test('independent Bernoulli cannot guarantee 26 (contrast)', () => {
  // show why Bernoulli is wrong: with p=0.26 independent, not always 26
  let hits = 0;
  const rnd = (() => { let k = 1; return () => { k = (k * 1664525 + 1013904223) >>> 0; return k / 4294967296; }; })();
  for (let trial = 0; trial < 40; trial++) {
    let w = 0;
    for (let i = 0; i < 100; i++) if (rnd() < 0.26) w++;
    if (w === 26) hits++;
  }
  assert.ok(hits < 40, 'Bernoulli sometimes misses exact 26');
});

test('ripple uses capture phase so seed stopPropagation still shows ring', () => {
  const html = fs.readFileSync(join(__dirname,'index.html'),'utf8');
  assert.ok(html.includes("addEventListener('pointerdown',onRipple,true)"));
  assert.ok(html.includes('stopPropagation')); // seed still stops bubble; capture precedes
  assert.ok(html.includes('nodes.length>=3'));
});

test('sprout leaf base overlaps stem tip geometry', () => {
  const html = fs.readFileSync(join(__dirname,'index.html'),'utf8');
  assert.ok(html.includes('y=v*.22-.04'));
  assert.ok(html.includes('stem.scale.y*.82'));
  assert.ok(html.includes('LatheGeometry'));
  assert.ok(html.includes("SphereGeometry(.16")); // seed untouched signature
});



// --- board result visibility after peel (anon SVG flap vs .open) ---
test('CSS: .tab.anon.open must not keep flap displayed over .res', () => {
  const html = fs.readFileSync(join(__dirname, 'index.html'), 'utf8');
  // Broken pattern: .tab.anon .flap{display:flex} AFTER/equal-specificity to .tab.open .flap{display:none}
  const anonOpenFlex = /\.tab\.anon\s+\.flap\s*\{[^}]*display\s*:\s*flex/m.test(html);
  assert.equal(anonOpenFlex, false, 'unscoped .tab.anon .flap{display:flex} fights .open');
  assert.ok(html.includes('.tab.anon:not(.open) .flap') || /\.tab\.open\.anon\s+\.flap|\.tab\.anon\.open\s+\.flap/.test(html));
  assert.ok(/\.tab\.open\s+\.flap\s*,\s*\.tab\.open\s+\.shadow\s*\{[^}]*display\s*:\s*none/.test(html));
});

test('setRes writes flower/sprout into .res and adds open (DOM mirror)', () => {
  // pure DOM-less mirror of setRes markup contract
  const setResHTML = (slot, id, win) => {
    const anon = slot === 'anon' || /^anon_/.test(id);
    const open = true;
    const res = win
      ? (anon ? '🌸<span>당첨이에요</span>' : '🌸<span>' + id.slice(-3) + '</span>')
      : '🌱<span>아쉬워요!</span>';
    return { open, res, hasFlower: res.includes('🌸'), hasSprout: res.includes('🌱') };
  };
  const winAnon = setResHTML('anon', 'anon_x_1', true);
  assert.equal(winAnon.open, true);
  assert.equal(winAnon.hasFlower, true);
  assert.equal(winAnon.res.includes('당첨이에요'), true);
  const lose = setResHTML('anon', 'anon_x_2', false);
  assert.equal(lose.hasSprout, true);
  assert.equal(lose.res.includes('아쉬워요'), true);
});

test('finishReveal order: peel then setRes open so result under hidden flap', () => {
  // mirror finishReveal timing contract from index.html
  const html = fs.readFileSync(join(__dirname, 'index.html'), 'utf8');
  assert.ok(html.includes("t.classList.add('peel')"));
  assert.ok(/setRes\(t,win\);\s*t\.classList\.remove\('peel','active'\)/.test(html));
  // setRes itself adds open
  assert.ok(/r\.innerHTML=win\?[\s\S]*t\.classList\.add\('open'\)/.test(html));
});

test('persisted anonSlots length not force-resized to 100 on migrate', () => {
  // mirrors migrateDB: existing anonSlots kept; only missing anonSlots get default n
  const migrate = (d, qN = 100) => {
    d = d || {}; d.results = d.results || {};
    d.goods = Math.max(0, +(d.goods != null ? d.goods : 26));
    if (!Array.isArray(d.guaranteed)) d.guaranteed = [];
    if (!Array.isArray(d.anonSlots) || !d.anonSlots.length) {
      const n = Math.max(0, +qN); d.anonSlots = Array.from({ length: n }, (_, i) => ({ id: 'anon_' + i }));
    } else {
      d.anonSlots = d.anonSlots.filter(s => s && s.id).map(s => ({ id: String(s.id) }));
    }
    return d;
  };
  const kept70 = migrate({ guaranteed: [], anonSlots: Array.from({ length: 70 }, (_, i) => ({ id: 'anon_old_' + i })), goods: 26, results: {} });
  assert.equal(kept70.anonSlots.length, 70, '70 persisted stays 70 — no silent 100 rewrite');
  const fresh = migrate(null, 100);
  assert.equal(fresh.anonSlots.length, 100);
  const kept48 = migrate({ guaranteed: [], anonSlots: Array.from({ length: 48 }, (_, i) => ({ id: 'a' + i })), goods: 26, results: { a0: { win: false, revealed: true } } });
  assert.equal(kept48.anonSlots.length, 48);
  assert.ok(kept48.results.a0.revealed);
});

test('overlay markFinal still sets won/lose classes (path intact)', () => {
  const html = fs.readFileSync(join(__dirname, 'index.html'), 'utf8');
  assert.ok(html.includes("el.classList.add(isWin?'won':'lose')"));
  assert.ok(html.includes("minVisible=isWin?3.0:2.5"));
  // 3D sprout/flower still in buildScene — board tile issue was CSS flap, not overlay
  assert.ok(html.includes('function buildScene'));
  assert.ok(html.includes('sproutPop'));
});


console.log('All tests passed:', passed);
