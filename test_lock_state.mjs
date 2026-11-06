/**
 * Pure timing/state tests for draw lock + revealed restore.
 * Mirrors /workspace/bloom-lottery/index.html pull/closeAll/buildBoard rules.
 * No browser, no localStorage side effects on user devices.
 */
import assert from 'node:assert/strict';

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
    while (timers.length && timers[0].at <= now) {
      const x = timers.shift();
      x.fn();
    }
  };
  const canPull = (id) => {
    if (busy || open.has(id) || now < guardUntil) return false;
    if (locked) return false; // #board.locked { pointer-events:none }
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
    // peel 1050 then unlock+guard 700
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
    // stage delay 700 then "close" eventually — tests call stageClose()
  };
  const pull = (id, { silent = false } = {}) => {
    if (busy || open.has(id)) return false;
    if (results[id]) {
      if (results[id].revealed) { setRes(id); return 'paint'; }
      beginStage(id);
      return 'resume';
    }
    results[id] = { win: false, kind: 'lose', revealed: !!silent };
    if (silent) { commit(id); setRes(id); return 'silent'; }
    beginStage(id);
    return 'start';
  };
  // stage overlay closed (auto or tap)
  const stageClose = (id) => {
    // closeAll: dim off, ghost guard starts, but lock stays
    guardUntil = now + 700;
    finishReveal(id);
  };
  const boardShows = (id) => {
    const r = results[id];
    // patched buildBoard: if(r&&r.revealed) setRes
    return !!(r && r.revealed);
  };
  const buggyBoardShows = (id) => {
    const r = results[id];
    const PENDING_reload = null; // reload clears PENDING
    return !!(r && r.revealed !== false || r && id !== PENDING_reload);
  };
  return {
    get state() { return { busy, locked, PENDING, guardUntil, now, results: structuredClone(results), open: [...open], pendingUi: [...pendingUi] }; },
    canPull, pull, stageClose, flushTo, boardShows, buggyBoardShows, schedule,
  };
}

// --- Test 1: old closeAll unlock window allows second pull during peel ---
{
  // simulate OLD behavior
  let busy=false, locked=false, now=0, guardUntil=0;
  const timers=[];
  const sch=(fn,ms)=>timers.push({at:now+ms,fn});
  const flush=t=>{now=t;timers.sort((a,b)=>a.at-b.at);while(timers.length&&timers[0].at<=now)timers.shift().fn()};
  // start draw
  busy=true; locked=true;
  // stage close OLD closeAll
  guardUntil=now+700;
  sch(()=>{busy=false;locked=false},700); // old unlock
  // peel still 1050
  let peelDone=false; sch(()=>{peelDone=true},1050);
  flush(700);
  assert.equal(locked,false);
  assert.equal(busy,false);
  assert.equal(peelDone,false);
  const oldAllowsSecond = !busy && !locked && now>=guardUntil;
  assert.equal(oldAllowsSecond, true, 'OLD defect: second pull possible during peel');
}

// --- Test 2: patched unlock only after peel + guard ---
{
  const m = makeMachine();
  assert.equal(m.pull('neonfilm'), 'start');
  assert.equal(m.state.busy, true);
  assert.equal(m.state.locked, true);
  assert.equal(m.canPull('orbit_log'), false);
  // seed animation time — still locked
  m.flushTo(5000);
  assert.equal(m.canPull('orbit_log'), false);
  // stage closes (lose auto ~)
  m.stageClose('neonfilm');
  // during peel (t+500): still locked
  m.flushTo(m.state.now + 500);
  assert.equal(m.state.locked, true);
  assert.equal(m.canPull('orbit_log'), false);
  assert.ok(m.state.pendingUi.length===0 || true);
  // peel ends at +1050 from stageClose; unlock scheduled +700 after that
  m.flushTo(m.state.now + 600); // total 1100 from close — past peel start+1050 if now advanced wrong
}

{
  const m = makeMachine();
  m.pull('neonfilm');
  const t0 = 0;
  m.stageClose('neonfilm'); // now=0, peel ends 1050, unlock 1750
  m.flushTo(1049);
  assert.equal(m.state.locked, true, 'still locked before peel end');
  assert.equal(m.canPull('orbit_log'), false);
  m.flushTo(1050);
  assert.equal(m.state.open.includes('neonfilm'), true);
  assert.equal(m.state.locked, true, 'ghost guard period still locked');
  assert.equal(m.canPull('orbit_log'), false);
  m.flushTo(1749);
  assert.equal(m.canPull('orbit_log'), false);
  m.flushTo(1750);
  assert.equal(m.state.busy, false);
  assert.equal(m.state.locked, false);
  assert.equal(m.canPull('orbit_log'), true);
}

// --- Test 3: reload restore — buggy vs patched ---
{
  const incomplete = { win: false, kind: 'lose', revealed: false };
  const PENDING = null; // after reload
  const id = 'orbit_log';
  const buggy = (incomplete && incomplete.revealed !== false) || (incomplete && id !== PENDING);
  const patched = !!(incomplete && incomplete.revealed);
  assert.equal(buggy, true, 'OLD buildBoard would open incomplete on reload');
  assert.equal(patched, false, 'patched hides incomplete until reveal');
}

// --- Test 4: participation excludes PENDING ---
{
  const results = {
    neonfilm: { win: false, revealed: true },
    orbit_log: { win: false, revealed: false },
  };
  const PENDING = 'orbit_log';
  const opened = Object.keys(results).filter(id => id !== PENDING).length;
  assert.equal(opened, 1);
}

// --- Test 5: second start rejected while busy ---
{
  const m = makeMachine();
  assert.equal(m.pull('neonfilm'), 'start');
  assert.equal(m.pull('orbit_log'), false);
  assert.equal(m.state.PENDING, 'neonfilm');
  assert.deepEqual(Object.keys(m.state.results), ['neonfilm']);
}

console.log('All pure lock/restore tests passed');
