/**
 * Cat state management for Claw Relay
 *
 * Notification types:
 *   repeating - fires after initialDelayMinutes, then doubles delay up to maxDelayMinutes,
 *               repeats at maxDelayMinutes; resets each time lastCatOutAt updates
 *   absolute  - fires at a specific HH:MM each day if ≥1 non-outdoorOnly cat is outside
 *
 * Delivery options (combo — any combination):
 *   { vibration, meow, phoneSound, phoneSoundUri, tts, ttsText }
 *
 * Mute: state.mute.until (timestamp ms) — delivery is suppressed while muted
 */

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, 'cats-state.json');

let pushToClients = null;

// In-memory scheduling state (reset on restart — safe since lastCatOutAt is persisted)
let repeatingState = {};    // notifId → { nextFireAt, currentDelayMs }
let absoluteFiredToday = {}; // notifId → 'YYYY-MM-DD'
let checkerInterval = null;

// ---- Default state ----

const DEFAULT_STATE = {
  cats: {
    Ty:                  { state: 'unknown', stateSetAt: null, outdoorOnly: false, image: null },
    GentlemanMustachios: { state: 'unknown', stateSetAt: null, outdoorOnly: false, image: null },
    Nocci:               { state: 'unknown', stateSetAt: null, outdoorOnly: false, image: null },
    Nommy:               { state: 'unknown', stateSetAt: null, outdoorOnly: false, image: null },
    Smoresy:             { state: 'unknown', stateSetAt: null, outdoorOnly: false, image: null },
    Cay:                 { state: 'outside', stateSetAt: null, outdoorOnly: true,  image: null }
  },
  notifications: [],
  lastCatOutAt: null,
  mute: { until: null }
};

// ---- Persistence ----

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      const loaded = JSON.parse(raw);
      return {
        ...DEFAULT_STATE,
        ...loaded,
        cats: { ...DEFAULT_STATE.cats, ...(loaded.cats || {}) },
        mute: loaded.mute || { until: null }
      };
    }
  } catch (e) {
    console.error('[cats] Failed to load state:', e.message);
  }
  return JSON.parse(JSON.stringify(DEFAULT_STATE));
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('[cats] Failed to save state:', e.message);
  }
}

let state = loadState();
console.log('[cats] State loaded. Cats:', Object.keys(state.cats).join(', '));

// ---- Helpers ----

function getOutdoorCats() {
  return Object.entries(state.cats)
    .filter(([, c]) => !c.outdoorOnly && c.state === 'outside')
    .map(([name]) => name);
}

function getUnknownCats() {
  return Object.entries(state.cats)
    .filter(([, c]) => !c.outdoorOnly && c.state === 'unknown')
    .map(([name]) => name);
}

// Cats that should trigger notifications: outside OR unknown
function getAlertCats() {
  return Object.entries(state.cats)
    .filter(([, c]) => !c.outdoorOnly && (c.state === 'outside' || c.state === 'unknown'))
    .map(([name]) => name);
}

function anyOutdoor() {
  return getAlertCats().length > 0;
}

function formatCatList(names) {
  if (names.length === 0) return 'no cats';
  if (names.length === 1) return names[0];
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

function isMuted() {
  return state.mute && state.mute.until && Date.now() < state.mute.until;
}

// ---- Notification delivery ----

function deliverNotification(notification, reason) {
  const outdoorCats = getOutdoorCats();
  if (outdoorCats.length === 0) {
    console.log(`[cats] Skipping "${notification.id}" — no cats outside`);
    return;
  }
  if (isMuted()) {
    const remaining = Math.round((state.mute.until - Date.now()) / 60000);
    console.log(`[cats] Skipping "${notification.id}" — muted for ${remaining} more min`);
    return;
  }

  const outsideCats = getOutdoorCats();
  const unknownCats = getUnknownCats();
  const catStr = formatCatList(outdoorCats);
  const outsideStr = formatCatList(outsideCats);
  const unknownStr = formatCatList(unknownCats);
  const msg = (notification.message || '{cats} are outside')
    .replace('{cats}', catStr)
    .replace('{outsideCats}', outsideStr || 'none')
    .replace('{unknownCats}', unknownStr || 'none');

  // Resolve delivery options (support legacy notificationType field)
  let delivery = notification.delivery;
  if (!delivery) {
    const t = notification.notificationType || 'noise_tts';
    delivery = {
      vibration: t === 'vibration' || t === 'noise_tts',
      meow: false,
      phoneSound: t === 'noise' || t === 'noise_tts',
      tts: t === 'noise_tts'
    };
  }

  console.log(`[cats] Firing notification "${notification.id}" (${reason}): ${msg}`);

  if (pushToClients) {
    pushToClients({
      action: 'cat_notification',
      message: msg,
      delivery,
      source: 'cat-watch'
    });
  }
}

// ---- Scheduling (unified 1-min interval) ----

function resetRepeatingState() {
  repeatingState = {};
  const base = state.lastCatOutAt || Date.now();  // never bail silently

  const repeating = state.notifications.filter(n => n.type === 'repeating');
  for (const n of repeating) {
    const delayMs = (n.initialDelayMinutes || 60) * 60 * 1000;
    repeatingState[n.id] = {
      nextFireAt: base + delayMs,
      currentDelayMs: delayMs
    };
    console.log(`[cats] Repeating "${n.id}" armed: fires in ${Math.round((repeatingState[n.id].nextFireAt - Date.now()) / 60000)} min`);
  }
}

// Restart repeating timers from initialDelay (user confirmed cats checked)
function restartRepeatingTimers() {
  const now = Date.now();
  const repeating = state.notifications.filter(n => n.type === 'repeating');
  for (const n of repeating) {
    const delayMs = (n.initialDelayMinutes || 60) * 60 * 1000;
    repeatingState[n.id] = { nextFireAt: now + delayMs, currentDelayMs: delayMs };
    console.log(`[cats] Repeating "${n.id}" restarted: fires in ${Math.round(delayMs / 60000)} min`);
  }
}

function clearRepeatingState() {
  repeatingState = {};
  console.log('[cats] Repeating state cleared');
}

function startChecker() {
  if (checkerInterval) clearInterval(checkerInterval);

  checkerInterval = setInterval(() => {
    if (!anyOutdoor()) return;

    const now = Date.now();
    const todayStr = new Date().toISOString().slice(0, 10);
    const hhmm = new Date().toTimeString().slice(0, 5);

    // --- Repeating notifications ---
    for (const notif of state.notifications.filter(n => n.type === 'repeating')) {
      const rs = repeatingState[notif.id];
      if (!rs) continue;
      if (now >= rs.nextFireAt) {
        deliverNotification(notif, 'repeating-timer');
        const maxMs = (notif.maxDelayMinutes || 240) * 60 * 1000;
        rs.currentDelayMs = Math.min(rs.currentDelayMs * 2, maxMs);
        rs.nextFireAt = now + rs.currentDelayMs;
        console.log(`[cats] Repeating "${notif.id}" next fire in ${Math.round(rs.currentDelayMs / 60000)} min`);
        // Push updated repeatingState so clients show the correct next-fire time
        if (pushToClients) pushToClients({ action: 'repeating_state_update', repeatingState });
      }
    }

    // --- Absolute notifications ---
    for (const notif of state.notifications.filter(n => n.type === 'absolute')) {
      if (notif.absoluteTime === hhmm && absoluteFiredToday[notif.id] !== todayStr) {
        absoluteFiredToday[notif.id] = todayStr;
        deliverNotification(notif, 'absolute-time');
      }
    }
  }, 10 * 1000);  // 10s resolution — max alarm latency reduced from 60s to 10s
}

// ---- Mute ----

function setMute(until) {
  state.mute = { until: until || null };
  saveState();

  // Broadcast mute state to all clients
  if (pushToClients) {
    pushToClients({ action: 'mute_state', mute: state.mute });
  }

  const label = until ? `until ${new Date(until).toISOString()}` : 'cleared';
  console.log(`[cats] Mute ${label}`);
  return { ok: true, mute: state.mute };
}

function getMute() {
  // Auto-expire
  if (state.mute.until && Date.now() >= state.mute.until) {
    state.mute = { until: null };
    saveState();
  }
  return state.mute;
}

// ---- State changes ----

function setCatState(catName, newState, source = 'app') {
  const cat = state.cats[catName];
  if (!cat) return { ok: false, error: 'cat not found' };
  if (cat.outdoorOnly) return { ok: false, error: 'cat is outdoor-only' };

  const oldState = cat.state;
  cat.state = newState;
  cat.stateSetAt = Date.now();

  console.log(`[cats] ${catName}: ${oldState} → ${newState} (via ${source})`);

  if (newState === 'outside' || newState === 'unknown') {
    // Set lastCatOutAt for outside; for unknown use now if not already set
    if (newState === 'outside') state.lastCatOutAt = cat.stateSetAt;
    else if (!state.lastCatOutAt) state.lastCatOutAt = cat.stateSetAt;
    // Always re-arm timers on any transition to alert state so push has fresh state
    resetRepeatingState();
  } else if (newState === 'inside' && !anyOutdoor()) {
    // Only clear timers when ALL alert cats are gone
    clearRepeatingState();
    state.lastCatOutAt = null;
  }

  saveState();

  if (pushToClients) {
    pushToClients({
      action: 'cat_state_changed',
      catName,
      state: newState,
      stateSetAt: cat.stateSetAt,
      source
    });
    // Also push updated repeatingState so clients can update alarm countdowns
    pushToClients({
      action: 'repeating_state_update',
      repeatingState
    });
  }

  return { ok: true, catName, oldState, newState, stateSetAt: cat.stateSetAt };
}

function updateCatConfig(catName, config) {
  if (!state.cats[catName]) {
    state.cats[catName] = { state: 'unknown', stateSetAt: null, outdoorOnly: false, image: null, ...config };
  } else {
    state.cats[catName] = { ...state.cats[catName], ...config };
  }
  saveState();
  if (pushToClients) pushToClients({ action: 'cat_config_changed', catName, cat: state.cats[catName] });
  return { ok: true, catName, cat: state.cats[catName] };
}

// ---- Notification config ----

function setNotifications(notifications) {
  state.notifications = notifications;
  saveState();
  resetRepeatingState();
  return { ok: true, count: notifications.length };
}

function addNotification(notif) {
  if (!notif.id) notif.id = `notif-${Date.now()}`;
  // Guard against duplicates (e.g. client retry)
  if (state.notifications.some(n => n.id === notif.id)) {
    console.warn(`[cats] addNotification: duplicate id ${notif.id}, ignoring`);
    return { ok: true, notification: notif, duplicate: true };
  }
  state.notifications.push(notif);
  saveState();
  resetRepeatingState();
  return { ok: true, notification: notif };
}

function updateNotification(id, patch) {
  const idx = state.notifications.findIndex(n => n.id === id);
  if (idx === -1) return { ok: false, error: 'not found' };
  state.notifications[idx] = { ...state.notifications[idx], ...patch };
  saveState();
  resetRepeatingState();
  return { ok: true, notification: state.notifications[idx] };
}

function removeNotification(id) {
  const idx = state.notifications.findIndex(n => n.id === id);
  if (idx === -1) return { ok: false, error: 'not found' };
  state.notifications.splice(idx, 1);
  delete repeatingState[id];
  saveState();
  return { ok: true };
}

// ---- Public API ----

module.exports = {
  init(pushFn) {
    pushToClients = pushFn;
    startChecker();
    if (state.lastCatOutAt && anyOutdoor()) {
      console.log('[cats] Re-arming repeating timers after restart');
      resetRepeatingState();
    }
  },

  getAll() {
    return {
      cats: state.cats,
      notifications: state.notifications,
      lastCatOutAt: state.lastCatOutAt,
      outdoorCats: getOutdoorCats(),
      unknownCats: getUnknownCats(),
      alertCats: getAlertCats(),
      mute: getMute()
    };
  },

  getCat(name) { return state.cats[name] || null; },

  setCatState,
  updateCatConfig,
  setNotifications,
  addNotification,
  updateNotification,
  removeNotification,
  setMute,
  getMute,

  restartRepeatingTimers,
  getStateSnapshot() {
    return {
      type: 'cat_state_snapshot',
      cats: state.cats,
      notifications: state.notifications,
      lastCatOutAt: state.lastCatOutAt,
      mute: getMute(),
      repeatingState   // { notifId: { nextFireAt, currentDelayMs } }
    };
  }
};
