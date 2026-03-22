const express = require('express');
const { WebSocketServer } = require('ws');
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');
const cats = require('./cats');
const location = require('./location');
const weight = require('./weight');

const WS_PORT = 18790;
const HTTP_PORT = 18791;
const AUTH_TOKEN = process.env.RELAY_TOKEN || 'claw-relay-default';

// --- Firebase Admin init ---
const serviceAccountPath = path.join(__dirname, 'firebase-service-account.json');
try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccountPath)
  });
  console.log('[firebase] Admin SDK initialized');
} catch (e) {
  console.error('[firebase] Failed to init:', e.message);
}

// --- WebSocket Server (for app connections) ---
const wss = new WebSocketServer({ port: WS_PORT, host: '0.0.0.0' });
const clients = new Map(); // id -> { ws, info, fcmToken, connectedAt }
const commandWaiters = new Map(); // commandId -> { resolve, timer }
let lastKnownFcmToken = null;

// Push a message to all (or specific) connected clients + SSE web dashboard
function pushToClients(payload, targetId = null) {
  const msg = JSON.stringify({ type: 'command', commandId: `push-${Date.now()}`, ...payload });
  for (const [id, client] of clients) {
    if (targetId && id !== targetId) continue;
    if (client.ws.readyState === 1) {
      client.ws.send(msg);
    }
  }
  // Mirror to SSE dashboard clients
  if (payload.action === 'task_update') {
    // Task updates get their own SSE event type so the dashboard can handle them directly
    broadcastSSE('task_update', { active: payload.active, completed: payload.completed });
  } else {
    const isCatAction = payload.action?.startsWith('cat') || payload.action === 'mute_state';
    broadcastSSE('update', {
      action: payload.action,
      cats: isCatAction ? cats.getStateSnapshot() : undefined,
      location: payload.action === 'location_update' ? location.getCurrent() : undefined,
      clients: clients.size,
    });
  }
}

// Init cats module with push function
cats.init(pushToClients);

wss.on('connection', (ws, req) => {
  const clientId = `app-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
  console.log(`[ws] Client connected: ${clientId} from ${req.socket.remoteAddress}`);

  clients.set(clientId, { ws, info: {}, fcmToken: null, connectedAt: new Date().toISOString() });
  cancelFcmWake();

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'register') {
        const client = clients.get(clientId);
        if (!client) return;
        client.info = msg.info || {};
        if (msg.fcmToken) {
          client.fcmToken = msg.fcmToken;
          lastKnownFcmToken = msg.fcmToken;
          console.log(`[ws] FCM token registered for ${clientId}: ${msg.fcmToken.substring(0, 20)}...`);
        }
        ws.send(JSON.stringify({ type: 'registered', clientId }));
        // Send current cat state snapshot to new client
        ws.send(JSON.stringify(cats.getStateSnapshot()));
        // Send named locations to new client
        ws.send(JSON.stringify({ type: 'location_places', places: location.getNamedLocations() }));
        // Send weight history to new client
        ws.send(JSON.stringify({ type: 'weight_data', entries: weight.parseEntries() }));
        // Send current task state to new client
        ws.send(JSON.stringify({
          type: 'command', action: 'task_update',
          active: readTasksJson(TASKS_ACTIVE_PATH).tasks || [],
          completed: (readTasksJson(TASKS_COMPLETED_PATH).tasks || []).slice(-20)
        }));

      } else if (msg.type === 'cat_state_update') {
        // App changed a cat state — update server and broadcast to other clients
        const result = cats.setCatState(msg.catName, msg.state, 'app');
        console.log(`[ws] Cat state update from app: ${msg.catName} → ${msg.state}`, result);
        ws.send(JSON.stringify({ type: 'cat_state_ack', ...result }));

      } else if (msg.type === 'request_test_ping') {
        // App asks server to send a ping back — tests full round-trip
        const message = msg.message || 'Server test ping — round trip confirmed!';
        const commandId = `cmd-test-${Date.now()}`;
        ws.send(JSON.stringify({ type: 'command', action: 'ping', message, commandId }));
        console.log(`[ws] Server test ping sent to ${clientId}`);

      } else if (msg.type === 'ack') {
        const waiter = commandWaiters.get(msg.commandId);
        if (waiter) {
          waiter.resolve({ delivered: true, via: 'websocket', clientId });
          commandWaiters.delete(msg.commandId);
        }

      } else if (msg.type === 'add_notification') {
        const result = cats.addNotification(msg.notification || {});
        ws.send(JSON.stringify({ type: 'notification_ack', ...result }));
        // Broadcast updated snapshot so all clients stay in sync
        pushToClients(cats.getStateSnapshot());

      } else if (msg.type === 'update_notification') {
        const result = cats.updateNotification(msg.id, msg.patch || {});
        ws.send(JSON.stringify({ type: 'notification_ack', ...result }));
        pushToClients(cats.getStateSnapshot());

      } else if (msg.type === 'remove_notification') {
        const result = cats.removeNotification(msg.id);
        ws.send(JSON.stringify({ type: 'notification_ack', ...result }));
        pushToClients(cats.getStateSnapshot());

      } else if (msg.type === 'restart_repeating') {
        // App user hit "Restart" — reset repeating timers to initialDelay
        cats.restartRepeatingTimers();
        console.log(`[ws] Repeating timers restarted by ${clientId}`);
        pushToClients(cats.getStateSnapshot());

      } else if (msg.type === 'set_mute') {
        // App setting mute state — broadcast to all clients
        const result = cats.setMute(msg.until || null);
        console.log(`[ws] Mute set by ${clientId}: until=${msg.until}`);
        ws.send(JSON.stringify({ type: 'mute_ack', ...result }));

      } else if (msg.type === 'location_update') {
        if (location.isTracking()) {
          const result = location.processUpdate(msg);
          // Push inferred location to all clients if it changed
          if (result.logged) {
            pushToClients({ action: 'location_update', current: location.getCurrent() });
          }
        }

      } else if (msg.type === 'set_location_tracking') {
        location.setTracking(!!msg.enabled);
        ws.send(JSON.stringify({ type: 'location_tracking_ack', tracking: location.isTracking() }));

      } else if (msg.type === 'save_named_location') {
        const result = location.addNamedLocation(msg.location || {});
        ws.send(JSON.stringify({ type: 'named_location_ack', ...result }));
        // Broadcast updated places list to all clients
        pushToClients({ action: 'location_places', places: location.getNamedLocations() });

      } else if (msg.type === 'save_weight_entry') {
        const result = weight.addEntry(msg.date, msg.weight, msg.notes || '');
        ws.send(JSON.stringify({ type: 'weight_ack', ...result }));
        // Broadcast updated weight data to all clients
        pushToClients({ action: 'weight_data', entries: weight.parseEntries() });

      } else if (msg.type === 'pong') {
        // keepalive
      }
    } catch (e) {
      console.error(`[ws] Bad message from ${clientId}:`, e.message);
    }
  });

  ws.on('close', () => {
    console.log(`[ws] Client disconnected: ${clientId}`);
    clients.delete(clientId);
    if (clients.size === 0) scheduleFcmWake();
  });

  ws.on('error', (err) => console.error(`[ws] Error for ${clientId}:`, err.message));

  ws.send(JSON.stringify({ type: 'welcome', clientId }));
});

// --- FCM wake-on-disconnect ---
// If no clients remain connected, prod the app back via FCM with exponential backoff.
// Resets on reconnect. 1min → 2min → 4min → ... → 30min → 30min → ...
const FCM_WAKE_INITIAL = 60 * 1000;
const FCM_WAKE_MAX = 30 * 60 * 1000;
let fcmWakeTimer = null;
let fcmWakeDelay = FCM_WAKE_INITIAL;

function scheduleFcmWake() {
  if (fcmWakeTimer) return;
  if (clients.size > 0) return;
  if (!lastKnownFcmToken) { console.log('[wake] No FCM token, skipping wake schedule'); return; }

  console.log(`[wake] No clients — scheduling FCM wake in ${Math.round(fcmWakeDelay/1000)}s`);
  fcmWakeTimer = setTimeout(async () => {
    fcmWakeTimer = null;
    if (clients.size > 0) { fcmWakeDelay = FCM_WAKE_INITIAL; return; } // reconnected, reset

    try {
      await admin.messaging().send({
        token: lastKnownFcmToken,
        // notification payload: FCM system shows this even if app is killed (bypasses Samsung battery kill)
        notification: { title: 'ClawApp', body: 'Reconnecting to relay...' },
        data: { action: 'wake', reason: 'relay_reconnect' },
        android: {
          priority: 'high',
          ttl: 60000,
          notification: { channelId: 'claw_alerts', priority: 'max' }
        }
      });
      console.log('[wake] FCM wake sent');
    } catch (e) {
      console.error('[wake] FCM wake failed:', e.message);
    }

    // Schedule next attempt with backoff
    fcmWakeDelay = Math.min(fcmWakeDelay * 2, FCM_WAKE_MAX);
    scheduleFcmWake();
  }, fcmWakeDelay);
}

function cancelFcmWake() {
  if (fcmWakeTimer) { clearTimeout(fcmWakeTimer); fcmWakeTimer = null; }
  fcmWakeDelay = FCM_WAKE_INITIAL; // reset backoff on reconnect
  console.log('[wake] Client connected — FCM wake cancelled, backoff reset');
}

// Keepalive ping every 25s
setInterval(() => {
  for (const [, client] of clients) {
    if (client.ws.readyState === 1) client.ws.send(JSON.stringify({ type: 'ping' }));
  }
}, 25000);

// --- Command delivery with FCM fallback ---
async function deliverCommand(commandData) {
  const { action, message, clientId: targetId, ...extra } = commandData;
  const commandId = `cmd-${Date.now()}`;
  const payload = JSON.stringify({ type: 'command', commandId, action, message: message || '', ...extra });

  let wsSent = 0;
  let fcmToken = null;
  for (const [id, client] of clients) {
    if (targetId && id !== targetId) continue;
    if (client.ws.readyState === 1) { client.ws.send(payload); wsSent++; }
    if (client.fcmToken) fcmToken = client.fcmToken;
  }

  if (wsSent > 0) {
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        commandWaiters.delete(commandId);
        resolve({ delivered: true, via: 'websocket', acked: false });
      }, 5000);
      commandWaiters.set(commandId, {
        resolve: (r) => { clearTimeout(timer); resolve({ ...r, acked: true }); }
      });
    });
    return { ok: true, commandId, ...result };
  }

  fcmToken = fcmToken || lastKnownFcmToken;
  if (fcmToken) {
    try {
      await admin.messaging().send({
        token: fcmToken,
        data: { action, message: message || '', commandId },
        android: { priority: 'high', ttl: 60000 }
      });
      return { ok: true, commandId, delivered: true, via: 'fcm' };
    } catch (e) {
      return { ok: false, commandId, error: 'fcm_failed', detail: e.message };
    }
  }

  return { ok: false, commandId, error: 'no_clients' };
}

// --- HTTP API ---
const app = express();
app.use(express.json());

function authCheck(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
  if (token !== AUTH_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// General
app.get('/health', authCheck, (req, res) => {
  res.json({ ok: true, clients: clients.size, fcmAvailable: !!lastKnownFcmToken });
});

app.get('/clients', authCheck, (req, res) => {
  const list = [];
  for (const [id, client] of clients) {
    list.push({ id, info: client.info, fcmToken: client.fcmToken ? '***' + client.fcmToken.slice(-8) : null, connectedAt: client.connectedAt, ready: client.ws.readyState === 1 });
  }
  res.json({ clients: list, lastKnownFcmToken: !!lastKnownFcmToken });
});

app.post('/command', authCheck, async (req, res) => {
  if (!req.body.action) return res.status(400).json({ error: 'action required' });
  res.json(await deliverCommand(req.body));
});

// ---- Cat API ----

// GET /cats — all cat states + notifications
app.get('/cats', authCheck, (req, res) => {
  res.json(cats.getAll());
});

// GET /cats/:name — single cat
app.get('/cats/:name', authCheck, (req, res) => {
  const cat = cats.getCat(req.params.name);
  if (!cat) return res.status(404).json({ error: 'cat not found' });
  res.json({ name: req.params.name, ...cat });
});

// POST /cats/:name/state — set cat state
// Body: { state: 'inside' | 'outside' | 'unknown' }
app.post('/cats/:name/state', authCheck, (req, res) => {
  const { state } = req.body;
  if (!['inside', 'outside', 'unknown'].includes(state)) {
    return res.status(400).json({ error: 'state must be inside | outside | unknown' });
  }
  res.json(cats.setCatState(req.params.name, state, 'claw'));
});

// POST /cats/:name/config — update cat config (name, outdoorOnly, image, etc.)
app.post('/cats/:name/config', authCheck, (req, res) => {
  res.json(cats.updateCatConfig(req.params.name, req.body));
});

// GET /cats/notifications — list notification configs
app.get('/cats/notifications', authCheck, (req, res) => {
  res.json({ notifications: cats.getAll().notifications });
});

// POST /cats/notifications — replace all notifications
app.put('/cats/notifications', authCheck, (req, res) => {
  if (!Array.isArray(req.body.notifications)) {
    return res.status(400).json({ error: 'notifications array required' });
  }
  res.json(cats.setNotifications(req.body.notifications));
});

// POST /cats/notifications/add — add one notification
app.post('/cats/notifications/add', authCheck, (req, res) => {
  res.json(cats.addNotification(req.body));
});

// PATCH /cats/notifications/:id — update notification
app.patch('/cats/notifications/:id', authCheck, (req, res) => {
  res.json(cats.updateNotification(req.params.id, req.body));
});

// DELETE /cats/notifications/:id — remove notification
app.delete('/cats/notifications/:id', authCheck, (req, res) => {
  res.json(cats.removeNotification(req.params.id));
});

// ---- Mute API ----

// GET /mute — get current mute state
app.get('/mute', authCheck, (req, res) => {
  res.json(cats.getMute());
});

// POST /mute — set mute (body: { until: timestamp } or { until: null } to unmute)
app.post('/mute', authCheck, (req, res) => {
  res.json(cats.setMute(req.body.until || null));
});

// ---- Location API ----

app.get('/location/current', authCheck, (req, res) => {
  res.json(location.getCurrent() || { error: 'no location data yet' });
});

app.get('/location/history', authCheck, (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json({ history: location.getHistory(limit) });
});

app.get('/location/places', authCheck, (req, res) => {
  res.json({ places: location.getNamedLocations() });
});

app.post('/location/places', authCheck, (req, res) => {
  res.json(location.addNamedLocation(req.body));
});

app.patch('/location/places/:id', authCheck, (req, res) => {
  res.json(location.updateNamedLocation(req.params.id, req.body));
});

app.delete('/location/places/:id', authCheck, (req, res) => {
  res.json(location.removeNamedLocation(req.params.id));
});

// "I'm here" — manually override inferred location to a named place
// Body: { name: "home" }  — must match an existing named location
app.post('/location/here', authCheck, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const place = location.getNamedLocations().find(l => l.name.toLowerCase() === name.toLowerCase());
  if (!place) return res.status(404).json({ error: 'place not found' });
  location.setManualLocation(name);
  broadcastSSE('update', { location: location.getCurrent(), clients: clients.size });
  res.json({ ok: true, name });
});

app.post('/location/tracking', authCheck, (req, res) => {
  location.setTracking(!!req.body.enabled);
  res.json({ tracking: location.isTracking() });
});

// --- Weight endpoints ---
app.get('/weight/history', authCheck, (req, res) => {
  res.json({ entries: weight.parseEntries() });
});

app.post('/weight/entry', authCheck, (req, res) => {
  const { date, weight: w, notes } = req.body;
  if (!date || w == null) return res.status(400).json({ error: 'date and weight required' });
  const result = weight.addEntry(date, parseFloat(w), notes || '');
  if (result.ok) pushToClients({ action: 'weight_data', entries: weight.parseEntries() });
  res.json(result);
});

// --- Task tracking: file-watch push, no client polling ---
const TASKS_ACTIVE_PATH = '/home/claw/.openclaw/workspace/tasks/active.json';
const TASKS_COMPLETED_PATH = '/home/claw/.openclaw/workspace/tasks/completed.json';

function readTasksJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (_) { return { tasks: [] }; }
}

function pushTaskUpdate() {
  const active = readTasksJson(TASKS_ACTIVE_PATH);
  const completed = readTasksJson(TASKS_COMPLETED_PATH);
  const payload = {
    action: 'task_update',
    active: active.tasks || [],
    completed: (completed.tasks || []).slice(-20) // last 20 only
  };
  pushToClients(payload);
  broadcastSSE('task_update', payload);
}

// Watch both files; debounce 200ms so atomic writes don't double-fire
let taskDebounce = null;
function scheduleTaskPush() {
  clearTimeout(taskDebounce);
  taskDebounce = setTimeout(pushTaskUpdate, 200);
}

function watchTaskFile(filePath) {
  // Create file if missing so watch doesn't fail
  if (!fs.existsSync(filePath)) {
    try { fs.writeFileSync(filePath, JSON.stringify({ tasks: [] }, null, 2)); } catch (_) {}
  }

  let watcher = null;

  function attach() {
    try {
      watcher = fs.watch(filePath, (event) => {
        scheduleTaskPush();
        // On rename (atomic mv), inotify watch dies — re-attach after short delay
        if (event === 'rename') {
          watcher = null;
          setTimeout(attach, 200);
        }
      });
    } catch (e) {
      // File may not exist yet (e.g. completed.json before first completion) — retry
      setTimeout(attach, 2000);
    }
  }

  attach();
  console.log(`[tasks] Watching ${filePath}`);
}

watchTaskFile(TASKS_ACTIVE_PATH);
watchTaskFile(TASKS_COMPLETED_PATH);

// HTTP endpoints still available for initial fetch / debugging
app.get('/tasks', authCheck, (req, res) => res.json(readTasksJson(TASKS_ACTIVE_PATH)));
app.get('/tasks/completed', authCheck, (req, res) => res.json(readTasksJson(TASKS_COMPLETED_PATH)));

// --- SSE: real-time event stream for the web dashboard ---
const sseClients = new Set();

function broadcastSSE(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch (_) { sseClients.delete(res); }
  }
}

app.get('/events', authCheck, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.add(res);

  // Send current state immediately on connect
  res.write(`event: init\ndata: ${JSON.stringify({
    cats: cats.getStateSnapshot(),
    location: location.getCurrent(),
    places: location.getNamedLocations(),
    clients: clients.size,
    tasks: {
      active: readTasksJson(TASKS_ACTIVE_PATH).tasks || [],
      completed: (readTasksJson(TASKS_COMPLETED_PATH).tasks || []).slice(-20)
    }
  })}\n\n`);

  req.on('close', () => sseClients.delete(res));
});

// --- Web Dashboard ---
app.get('/dashboard', (req, res) => {
  // Token in query param for browser access
  const token = req.query.token;
  if (token !== AUTH_TOKEN) {
    return res.status(401).send('<h2>Unauthorized — add ?token=YOUR_TOKEN to the URL</h2>');
  }
  const t = encodeURIComponent(token);
  res.setHeader('Content-Type', 'text/html');
  res.send(buildDashboardHtml(t));
});

function buildDashboardHtml(token) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>🦀 ClawApp Dashboard</title>
<style>
  :root {
    --bg: #121212; --surface: #1e1e1e; --surface2: #2a2a2a;
    --primary: #bb86fc; --green: #4caf50; --yellow: #ffc107;
    --red: #f44336; --text: #e0e0e0; --muted: #888;
    --border: #333;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 16px; }
  h1 { color: var(--primary); margin-bottom: 16px; font-size: 1.4rem; display: flex; align-items: center; gap: 8px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
  .card { background: var(--surface); border-radius: 12px; padding: 16px; border: 1px solid var(--border); }
  .card h2 { font-size: 0.9rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 12px; }
  .status-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  .dot.green { background: var(--green); }
  .dot.red { background: var(--red); }
  .dot.gray { background: var(--muted); }
  .dot.yellow { background: var(--yellow); }
  .cat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 8px; }
  .cat-tile { background: var(--surface2); border-radius: 8px; padding: 10px 8px; text-align: center; border: 2px solid transparent; transition: border-color 0.2s; }
  .cat-tile.outside { border-color: var(--yellow); }
  .cat-tile.inside { border-color: var(--green); }
  .cat-tile.unknown { border-color: var(--muted); }
  .cat-name { font-size: 0.8rem; font-weight: 600; margin-top: 4px; }
  .cat-state { font-size: 0.65rem; color: var(--muted); margin-top: 2px; }
  .cat-emoji { font-size: 1.6rem; }
  .state-btn { background: var(--surface); border: 1px solid var(--border); color: var(--muted); border-radius: 4px; padding: 2px 7px; font-size: 0.65rem; cursor: pointer; transition: all 0.15s; }
  .state-btn:hover { border-color: var(--primary); color: var(--text); }
  .state-btn.active-btn { background: var(--primary); color: #000; border-color: var(--primary); font-weight: 700; }
  .btn { background: var(--primary); color: #000; border: none; border-radius: 8px; padding: 8px 16px; cursor: pointer; font-size: 0.85rem; font-weight: 600; transition: opacity 0.15s; }
  .btn:hover { opacity: 0.85; }
  .btn.danger { background: var(--red); color: #fff; }
  .btn.secondary { background: var(--surface2); color: var(--text); border: 1px solid var(--border); }
  .btn-row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
  .loc-badge { display: inline-flex; align-items: center; gap: 6px; background: var(--surface2); border-radius: 20px; padding: 4px 12px; font-size: 0.85rem; }
  .conf-bar { height: 4px; border-radius: 2px; margin-top: 8px; background: var(--surface2); }
  .conf-fill { height: 100%; border-radius: 2px; transition: width 0.3s; }
  .mute-banner { background: #3a2a00; border: 1px solid var(--yellow); border-radius: 8px; padding: 10px 14px; margin-bottom: 16px; display: none; }
  .input { background: var(--surface2); border: 1px solid var(--border); color: var(--text); border-radius: 8px; padding: 8px 12px; font-size: 0.9rem; width: 100%; }
  .tag { font-size: 0.7rem; padding: 2px 8px; border-radius: 10px; background: var(--surface2); color: var(--muted); }
  .tag.green { background: #1a3a1a; color: var(--green); }
  .tag.yellow { background: #3a3000; color: var(--yellow); }
  #conn-status { font-size: 0.8rem; color: var(--muted); }
  .timestamp { font-size: 0.7rem; color: var(--muted); margin-top: 4px; }
</style>
</head>
<body>
<h1>🦀 ClawApp <span id="conn-status">connecting...</span></h1>

<!-- Task panel — always visible, push-updated -->
<div id="task-panel" onclick="toggleTaskExpand()" style="
  display:flex; align-items:center; justify-content:space-between;
  background:var(--surface2); border:1px solid var(--border); border-radius:8px;
  padding:7px 14px; margin-bottom:12px; cursor:pointer; user-select:none;
">
  <div style="display:flex;align-items:center;gap:10px">
    <span style="font-size:0.8rem;color:var(--muted)">TASKS</span>
    <span id="task-chips" style="display:flex;gap:8px;font-size:0.8rem"></span>
  </div>
  <span style="font-size:0.72rem;color:var(--muted)">tasks ›</span>
</div>
<div id="task-expand" style="display:none;margin-bottom:12px">
  <div id="task-list" style="display:flex;flex-direction:column;gap:8px"></div>
</div>

<div id="mute-banner" class="mute-banner" style="display:none">
  🔕 Muted until <span id="mute-until">—</span>
  <button class="btn secondary" style="margin-left:12px;padding:4px 10px;font-size:0.75rem" onclick="unmute()">Unmute</button>
</div>

<div class="grid">
  <!-- Cats -->
  <div class="card" style="grid-column: 1 / -1">
    <h2>🐱 Cats</h2>
    <div id="cat-grid" class="cat-grid">Loading...</div>
  </div>

  <!-- Location -->
  <div class="card">
    <h2>📍 Location</h2>
    <div id="loc-display">No data yet</div>
    <div class="conf-bar"><div id="conf-fill" class="conf-fill" style="width:0;background:var(--green)"></div></div>
    <div class="timestamp" id="loc-time">—</div>
    <div class="btn-row">
      <input id="loc-name-input" class="input" placeholder="Name this location..." style="flex:1" />
      <button class="btn secondary" onclick="saveLocation()">Save</button>
    </div>
  </div>

  <!-- Connection & Controls -->
  <div class="card">
    <h2>⚡ Controls</h2>
    <div class="status-row">
      <div id="app-dot" class="dot gray"></div>
      <span id="app-status">App not connected</span>
    </div>
    <div class="btn-row">
      <button class="btn secondary" onclick="testPing()">📍 Test Ping</button>
      <button class="btn secondary" onclick="muteQuick(60)">🔕 Mute 1h</button>
      <button class="btn secondary" onclick="muteQuick(0)">🔔 Unmute</button>
    </div>
  </div>

  <!-- Mute Controls -->
  <div class="card">
    <h2>🔔 Mute</h2>
    <div id="mute-status">—</div>
    <div class="btn-row" style="margin-top:8px">
      <button class="btn secondary" onclick="muteQuick(30)">30m</button>
      <button class="btn secondary" onclick="muteQuick(60)">1h</button>
      <button class="btn secondary" onclick="muteQuick(120)">2h</button>
      <button class="btn secondary" onclick="muteQuick(240)">4h</button>
      <button class="btn danger" onclick="unmute()">Unmute</button>
    </div>
  </div>

  <!-- Named Places -->
  <div class="card">
    <h2>🗺️ Known Places</h2>
    <div id="places-list">—</div>
  </div>

  <!-- Weight Graph -->
  <div class="card" style="grid-column: 1 / -1" id="weight-card">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
      <h2 style="margin:0">⚖️ Weight</h2>
      <div style="display:flex;gap:6px;align-items:center">
        <button class="btn secondary" id="weight-range-btn" onclick="cycleWeightRange()" style="padding:4px 10px;font-size:0.75rem">year</button>
        <button class="btn secondary" onclick="showWeightEntry()" style="padding:4px 10px;font-size:0.75rem">+ Log</button>
      </div>
    </div>
    <canvas id="weight-canvas" height="110" style="width:100%;cursor:pointer" onclick="cycleWeightRange()"></canvas>
    <div id="weight-latest" style="font-size:0.75rem;color:var(--muted);margin-top:6px">—</div>
  </div>
</div>

<!-- Weight entry dialog -->
<div id="weight-dialog" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:100;align-items:center;justify-content:center">
  <div style="background:var(--surface);border-radius:12px;padding:24px;min-width:280px;border:1px solid var(--border)">
    <h3 style="margin-bottom:16px">Log Weight</h3>
    <div id="weight-dialog-date" style="font-size:0.8rem;color:var(--muted);margin-bottom:8px"></div>
    <input id="weight-input" class="input" type="number" step="0.1" placeholder="Weight (lbs)" style="margin-bottom:8px">
    <input id="weight-notes-input" class="input" placeholder="Notes (optional)" style="margin-bottom:16px">
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button class="btn secondary" onclick="closeWeightDialog()">Cancel</button>
      <button class="btn" onclick="saveWeightEntry()">Save</button>
    </div>
  </div>
</div>

<script>
const TOKEN = '${token}';
const BASE = window.location.origin;

let state = { cats: {}, location: null, clients: 0, mute: null, tasks: { active: [], completed: [] } };

// SSE connection
function connectSSE() {
  const es = new EventSource(BASE + '/events?token=' + TOKEN);
  es.addEventListener('init', e => {
    const d = JSON.parse(e.data);
    applyInit(d);
    document.getElementById('conn-status').textContent = '● live';
    document.getElementById('conn-status').style.color = '#4caf50';
  });
  es.addEventListener('update', e => {
    const d = JSON.parse(e.data);
    if (d.cats?.cats) Object.assign(state.cats, d.cats.cats);
    if (d.cats?.mute) state.mute = d.cats.mute;
    if (d.location !== undefined) state.location = d.location;
    if (d.mute !== undefined) state.mute = d.mute;
    if (d.clients !== undefined) state.clients = d.clients;
    render();
  });
  es.addEventListener('task_update', e => {
    const d = JSON.parse(e.data);
    state.tasks = { active: d.active || [], completed: d.completed || [] };
    renderTasks();
  });
  es.onerror = () => {
    document.getElementById('conn-status').textContent = '● reconnecting...';
    document.getElementById('conn-status').style.color = '#f44336';
  };
}

function applyInit(d) {
  if (d.cats?.cats) state.cats = d.cats.cats;
  if (d.cats?.mute) state.mute = d.cats.mute;
  state.location = d.location;
  state.places = d.places || [];
  state.clients = d.clients || 0;
  if (d.tasks) state.tasks = d.tasks;
  render();
  renderTasks();
}

const CAT_EMOJI = { Ty:'🖤', GentlemanMustachios:'🎩', Nocci:'🍊', Nommy:'🧡', Smoresy:'💜', Cay:'🐾' };

function render() {
  // Cats
  const catGrid = document.getElementById('cat-grid');
  const catEntries = Object.entries(state.cats || {});
  if (catEntries.length === 0) { catGrid.textContent = 'No cats yet'; }
  else {
    catGrid.innerHTML = catEntries.map(([name, cat]) => {
      const st = cat.state || 'unknown';
      const emoji = CAT_EMOJI[name] || '🐱';
      const ago = cat.stateSetAt ? timeAgo(cat.stateSetAt) : '';
      const safeName = name.replace(/'/g, "\\'");
      const isOutdoorOnly = cat.outdoorOnly;
      return \`<div class="cat-tile \${st}">
        <div class="cat-emoji">\${emoji}</div>
        <div class="cat-name">\${name}</div>
        <div class="cat-state">\${st}\${ago ? ' · '+ago : ''}</div>
        \${!isOutdoorOnly ? \`<div style="display:flex;gap:4px;margin-top:6px;justify-content:center">
          <button class="state-btn\${st==='inside'?' active-btn':''}" onclick="setCatState('\${safeName}','inside')">in</button>
          <button class="state-btn\${st==='outside'?' active-btn':''}" onclick="setCatState('\${safeName}','outside')">out</button>
          <button class="state-btn\${st==='unknown'?' active-btn':''}" onclick="setCatState('\${safeName}','unknown')">?</button>
        </div>\` : '<div style="font-size:0.65rem;color:var(--muted);margin-top:4px">outdoor</div>'}
      </div>\`;
    }).join('');
  }

  // Location
  const loc = state.location;
  const locEl = document.getElementById('loc-display');
  const confFill = document.getElementById('conf-fill');
  const locTime = document.getElementById('loc-time');
  if (loc) {
    const conf = loc.locationConfidence ?? 0;
    const name = loc.inferredName;
    locEl.innerHTML = name
      ? \`<span class="loc-badge">\${name} <span class="tag \${conf>=60?'green':'yellow'}">\${conf}%</span></span>\`
      : \`<span class="loc-badge">Unknown · ±\${loc.accuracy ? Math.round(loc.accuracy) : '?'}m</span>\`;
    confFill.style.width = conf + '%';
    confFill.style.background = conf >= 60 ? 'var(--green)' : 'var(--yellow)';
    locTime.textContent = loc.timestamp ? 'Updated ' + timeAgo(loc.timestamp) : '';
  } else { locEl.textContent = 'No location data'; }

  // App connection
  const appDot = document.getElementById('app-dot');
  const appStatus = document.getElementById('app-status');
  if (state.clients > 0) {
    appDot.className = 'dot green';
    appStatus.textContent = 'App connected';
  } else {
    appDot.className = 'dot red';
    appStatus.textContent = 'App not connected';
  }

  // Mute
  const mute = state.mute;
  const muteEl = document.getElementById('mute-status');
  const muteBanner = document.getElementById('mute-banner');
  if (mute?.until && mute.until > Date.now()) {
    const until = new Date(mute.until);
    muteEl.textContent = '🔕 Muted until ' + until.toLocaleTimeString();
    document.getElementById('mute-until').textContent = until.toLocaleTimeString();
    muteBanner.style.display = 'block';
  } else {
    muteEl.textContent = '🔔 Active';
    muteBanner.style.display = 'none';
  }

  // Places — clickable "I'm here" + delete
  const placesEl = document.getElementById('places-list');
  if (state.places?.length) {
    const curName = state.location?.inferredName;
    placesEl.innerHTML = state.places.map(p => {
      const isHere = p.name === curName;
      return \`<div class="status-row" style="justify-content:space-between;margin-bottom:6px">
        <div style="display:flex;align-items:center;gap:8px">
          <span>\${isHere ? '📍' : '🗺️'}</span>
          <span style="font-weight:\${isHere?'700':'400'}">\${p.name}</span>
          <span class="tag\${isHere?' green':''}">\${p.wifiFingerprint?.length || 0} APs\${isHere?' · here':''}</span>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn secondary" style="padding:3px 10px;font-size:0.75rem" onclick="setHere('\${p.name.replace(/'/g,\"\\\\'\")}')">I'm here</button>
          <button class="btn danger" style="padding:3px 8px;font-size:0.75rem" onclick="deletePlace('\${p.id}')">✕</button>
        </div>
      </div>\`;
    }).join('');
  } else { placesEl.textContent = 'No saved places yet'; }
}

function setCatState(name, newState) {
  api('POST', '/cats/' + encodeURIComponent(name) + '/state', { state: newState })
    .then(d => {
      if (d.ok && state.cats[name]) {
        state.cats[name] = { ...state.cats[name], state: newState, stateSetAt: Date.now() };
        render();
      }
    });
}

function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s/60) + 'm ago';
  return Math.round(s/3600) + 'h ago';
}

async function api(method, path, body) {
  const r = await fetch(BASE + path + '?token=' + TOKEN, {
    method, headers: body ? {'Content-Type':'application/json'} : {},
    body: body ? JSON.stringify(body) : undefined
  });
  return r.json();
}

function testPing() {
  api('POST', '/command', { action: 'ping', message: 'Test ping from web dashboard' });
}

function muteQuick(minutes) {
  if (minutes === 0) { unmute(); return; }
  api('POST', '/cats/mute', { until: Date.now() + minutes * 60000 });
}

function unmute() {
  api('POST', '/cats/mute', { until: null });
}

function saveLocation() {
  const name = document.getElementById('loc-name-input').value.trim();
  if (!name) return;
  api('POST', '/location/places', {
    name,
    lat: state.location?.lat,
    lng: state.location?.lng,
    radiusM: Math.max(40, (state.location?.accuracy || 40) * 2),
    wifiFingerprint: state.location?.wifiScan || []
  }).then(() => { document.getElementById('loc-name-input').value = ''; refreshPlaces(); });
}

function setHere(name) {
  api('POST', '/location/here', { name }).then(() => {
    if (state.location) state.location = { ...state.location, inferredName: name, locationConfidence: 100 };
    render();
  });
}

function deletePlace(id) {
  if (!confirm('Delete this place?')) return;
  api('DELETE', '/location/places/' + id).then(() => refreshPlaces());
}

function refreshPlaces() {
  api('GET', '/location/places').then(d => { state.places = d.places || []; render(); });
}

// ---- Weight graph ----
let weightEntries = [];
let weightRange = 'year'; // 'week' | 'month' | 'year'
const WEIGHT_DAYS = { week: 7, month: 30, year: 365 };

function loadWeight() {
  api('GET', '/weight/history').then(d => {
    weightEntries = d.entries || [];
    renderWeight();
  });
}

function cycleWeightRange() {
  weightRange = weightRange === 'week' ? 'month' : weightRange === 'month' ? 'year' : 'week';
  document.getElementById('weight-range-btn').textContent = weightRange;
  renderWeight();
}

function renderWeight() {
  const canvas = document.getElementById('weight-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = 110 * dpr;
  ctx.scale(dpr, dpr);
  const W = rect.width, H = 110;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - WEIGHT_DAYS[weightRange]);
  const filtered = weightEntries.filter(e => new Date(e.date) >= cutoff)
    .sort((a, b) => a.date.localeCompare(b.date));

  const latestEl = document.getElementById('weight-latest');
  if (filtered.length === 0) {
    ctx.fillStyle = '#888';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No data for this period', W / 2, H / 2);
    latestEl.textContent = weightEntries.length ? 'No entries in selected range' : 'No weight data yet — long-press graph in app to log';
    return;
  }

  const padL = 42, padR = 8, padT = 8, padB = 20;
  const gW = W - padL - padR, gH = H - padT - padB;
  const weights = filtered.map(e => e.weight);
  const minW = Math.floor(Math.min(...weights) - 2);
  const maxW = Math.ceil(Math.max(...weights) + 2);
  const rangeW = maxW - minW;

  const xOf = i => padL + (i / Math.max(filtered.length - 1, 1)) * gW;
  const yOf = w => padT + gH - ((w - minW) / rangeW) * gH;

  // Grid lines + labels
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth = 0.5;
  ctx.fillStyle = '#888';
  ctx.font = '9px sans-serif';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const val = minW + (rangeW * i / 4);
    const y = yOf(val);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.fillText(Math.round(val), padL - 3, y + 3);
  }

  // Line
  if (filtered.length > 1) {
    ctx.beginPath();
    ctx.strokeStyle = '#bb86fc';
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    filtered.forEach((e, i) => {
      i === 0 ? ctx.moveTo(xOf(i), yOf(e.weight)) : ctx.lineTo(xOf(i), yOf(e.weight));
    });
    ctx.stroke();
  }

  // Dots
  const today = new Date().toISOString().slice(0, 10);
  filtered.forEach((e, i) => {
    const x = xOf(i), y = yOf(e.weight);
    const isToday = e.date === today;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = isToday ? '#4caf50' : '#bb86fc';
    ctx.fill();
    ctx.strokeStyle = '#121212'; ctx.lineWidth = 1.5;
    ctx.stroke();
  });

  // X labels (first, mid, last)
  ctx.fillStyle = '#888';
  ctx.font = '8px sans-serif';
  const labelIdxs = filtered.length <= 3 ? [...Array(filtered.length).keys()]
    : [0, Math.floor(filtered.length / 2), filtered.length - 1];
  labelIdxs.forEach(i => {
    const d = new Date(filtered[i].date + 'T00:00:00');
    const label = (d.getMonth() + 1) + '/' + d.getDate();
    const x = xOf(i);
    ctx.textAlign = i === 0 ? 'left' : i === filtered.length - 1 ? 'right' : 'center';
    ctx.fillText(label, x, H - 2);
  });

  // Latest weight display
  const last = filtered[filtered.length - 1];
  latestEl.textContent = \`\${last.weight} lbs · \${last.date}\${last.notes ? ' · ' + last.notes : ''}\`;
}

function showWeightEntry() {
  const today = new Date().toISOString().slice(0, 10);
  const existing = weightEntries.find(e => e.date === today);
  document.getElementById('weight-dialog-date').textContent = today;
  document.getElementById('weight-input').value = existing ? existing.weight : '';
  document.getElementById('weight-notes-input').value = existing?.notes || '';
  const dlg = document.getElementById('weight-dialog');
  dlg.style.display = 'flex';
  setTimeout(() => document.getElementById('weight-input').focus(), 50);
}

function closeWeightDialog() {
  document.getElementById('weight-dialog').style.display = 'none';
}

function saveWeightEntry() {
  const today = new Date().toISOString().slice(0, 10);
  const w = parseFloat(document.getElementById('weight-input').value);
  const notes = document.getElementById('weight-notes-input').value.trim();
  if (isNaN(w)) { alert('Enter a valid weight'); return; }
  api('POST', '/weight/entry', { date: today, weight: w, notes })
    .then(d => {
      if (d.ok) {
        closeWeightDialog();
        loadWeight();
      }
    });
}

// Refresh display every 10s — updates timestamps and client-side stall detection
setInterval(() => { render(); renderTasks(); }, 10000);

let taskExpanded = false;
function toggleTaskExpand() {
  taskExpanded = !taskExpanded;
  document.getElementById('task-expand').style.display = taskExpanded ? 'block' : 'none';
}

function renderTasks() {
  const tasks = state.tasks || { active: [], completed: [] };
  const all = [...(tasks.active || []), ...(tasks.completed || [])];

  // Compute counts with client-side stall detection
  const now = Math.floor(Date.now() / 1000);
  const effectiveStatus = t => (t.status === 'running' && t.timeoutAt && now > t.timeoutAt) ? 'stalled' : t.status;

  const counts = { running: 0, stalled: 0, complete: 0, failed: 0 };
  all.forEach(t => { const s = effectiveStatus(t); if (counts[s] !== undefined) counts[s]++; });

  // Chips
  const chips = [];
  if (counts.running)  chips.push(\`<span style="color:#4caf50;font-weight:600">⚡ \${counts.running}</span>\`);
  if (counts.stalled)  chips.push(\`<span style="color:#ffc107;font-weight:600">⚠️ \${counts.stalled}</span>\`);
  if (counts.failed)   chips.push(\`<span style="color:#f44336;font-weight:600">❌ \${counts.failed}</span>\`);
  if (counts.complete) chips.push(\`<span style="color:var(--muted)">✅ \${counts.complete}</span>\`);
  if (chips.length === 0) chips.push(\`<span style="color:var(--muted)">no tasks</span>\`);

  document.getElementById('task-chips').innerHTML = chips.join('');

  // Update panel background
  const panel = document.getElementById('task-panel');
  panel.style.background = counts.stalled || counts.failed
    ? 'rgba(244,67,54,0.12)' : counts.running
    ? 'rgba(187,134,252,0.10)' : 'var(--surface2)';
  panel.style.borderColor = counts.stalled || counts.failed
    ? 'rgba(244,67,54,0.4)' : counts.running
    ? 'rgba(187,134,252,0.35)' : 'var(--border)';

  // Expanded task list
  if (!taskExpanded) return;
  const listEl = document.getElementById('task-list');
  if (all.length === 0) { listEl.innerHTML = '<div style="color:var(--muted);font-size:0.85rem">No tasks</div>'; return; }

  const fmt = ts => ts ? new Date(ts * 1000).toLocaleString([], {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '—';
  const active = (tasks.active || []).slice().sort((a,b) => b.spawnedAt - a.spawnedAt);
  const recent = (tasks.completed || []).slice(-10).reverse();

  const renderCard = (t, dimmed) => {
    const st = effectiveStatus(t);
    const colors = { running:'#4caf50', stalled:'#ffc107', complete:'var(--muted)', failed:'#f44336' };
    const emojis = { running:'⚡', stalled:'⚠️', complete:'✅', failed:'❌' };
    const remaining = st === 'running' && t.timeoutAt ? t.timeoutAt - now : null;
    return \`<div style="background:var(--surface2);border-radius:8px;padding:10px 12px;opacity:\${dimmed?0.6:1}">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <span style="font-weight:600;font-size:0.85rem">\${emojis[st]||'❓'} \${t.label}</span>
        <span style="font-size:0.7rem;font-weight:700;color:\${colors[st]||'var(--muted)'}">\${st.toUpperCase()}</span>
      </div>
      \${t.description ? \`<div style="font-size:0.75rem;color:var(--muted);margin-bottom:3px">\${t.description}</div>\` : ''}
      \${t.notes ? \`<div style="font-size:0.7rem;font-family:monospace;color:var(--muted);opacity:0.8">\${t.notes}</div>\` : ''}
      <div style="display:flex;gap:10px;margin-top:5px;font-size:0.7rem;color:var(--muted)">
        <span>type:\${t.type}</span>
        <span>spawned:\${fmt(t.spawnedAt)}</span>
        \${remaining !== null && remaining > 0 ? \`<span style="color:\${remaining<300?'#ffc107':'var(--muted)'}">timeout:\${Math.floor(remaining/60)}m</span>\` : ''}
      </div>
    </div>\`;
  };

  let html = '';
  if (active.length) html += active.map(t => renderCard(t, false)).join('');
  if (recent.length) {
    if (active.length) html += '<div style="font-size:0.7rem;color:var(--muted);margin-top:8px;letter-spacing:0.05em">RECENT</div>';
    html += recent.map(t => renderCard(t, true)).join('');
  }
  listEl.innerHTML = html;
}

loadWeight();
connectSSE();
</script>
</body>
</html>`;
}

app.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`[relay] HTTP API on 0.0.0.0:${HTTP_PORT}`);
  console.log(`[relay] WebSocket on 0.0.0.0:${WS_PORT}`);
});
