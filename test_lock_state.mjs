/**
 * Pure timing/state tests: draw lock + revealed restore + public vs reserved counters.
 * Mirrors /workspace/bloom-lottery/index.html — no browser.
 */
import assert from 'node:assert/strict';

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

console.log('All tests passed:', passed);
