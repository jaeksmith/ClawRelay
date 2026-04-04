const express = require('express');
const { WebSocketServer } = require('ws');
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');
const cats = require('./cats');
const location = require('./location');
const weight = require('./weight');
const health = require('./health');
const notes = require('./notes');

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
  } else if (payload.action === 'health_data') {
    broadcastSSE('health_data', { heartRate: payload.heartRate, bloodPressure: payload.bloodPressure });
  } else if (payload.action === 'notes_update') {
    broadcastSSE('notes_update', { notes: payload.notes });
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
        // Send health data to new client
        ws.send(JSON.stringify({ type: 'health_data', heartRate: health.parseHeartRate(), bloodPressure: health.parseBloodPressure() }));
        // Send current task state to new client
        ws.send(JSON.stringify({
          type: 'command', action: 'task_update',
          active: readTasksJson(TASKS_ACTIVE_PATH).tasks || [],
          completed: (readTasksJson(TASKS_COMPLETED_PATH).tasks || []).slice(-20)
        }));
        // Send notes data to new client
        ws.send(JSON.stringify({
          type: 'notes_data',
          notes: notes.listNotes(false),
          settings: notes.getSettings()
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

      } else if (msg.type === 'save_heart_rate') {
        const result = health.addHeartRate(msg.date, msg.bpm);
        ws.send(JSON.stringify({ type: 'health_ack', ...result }));
        pushToClients({ action: 'health_data', heartRate: health.parseHeartRate(), bloodPressure: health.parseBloodPressure() });

      } else if (msg.type === 'save_blood_pressure') {
        const result = health.addBloodPressure(msg.date, msg.systolic, msg.diastolic);
        ws.send(JSON.stringify({ type: 'health_ack', ...result }));
        pushToClients({ action: 'health_data', heartRate: health.parseHeartRate(), bloodPressure: health.parseBloodPressure() });

      } else if (msg.type === 'create_note') {
        const result = notes.createNote(msg.name, msg.content || '', msg.meta || {});
        ws.send(JSON.stringify({ type: 'note_ack', ...result }));
        const allNotes = notes.listNotes(false);
        pushToClients({ action: 'notes_update', notes: allNotes });
        broadcastSSE('notes_update', { notes: allNotes });

      } else if (msg.type === 'update_note') {
        const result = notes.updateNote(msg.id, msg.content, msg.meta || {});
        ws.send(JSON.stringify({ type: 'note_ack', ...result }));
        const allNotes = notes.listNotes(false);
        pushToClients({ action: 'notes_update', notes: allNotes });
        broadcastSSE('notes_update', { notes: allNotes });

      } else if (msg.type === 'archive_note') {
        const result = notes.archiveNote(msg.id);
        ws.send(JSON.stringify({ type: 'note_ack', ...result }));
        const allNotes = notes.listNotes(false);
        pushToClients({ action: 'notes_update', notes: allNotes });
        broadcastSSE('notes_update', { notes: allNotes });

      } else if (msg.type === 'unarchive_note') {
        const result = notes.unarchiveNote(msg.id);
        ws.send(JSON.stringify({ type: 'note_ack', ...result }));
        const allNotes = notes.listNotes(false);
        pushToClients({ action: 'notes_update', notes: allNotes });
        broadcastSSE('notes_update', { notes: allNotes });

      } else if (msg.type === 'delete_note') {
        const result = notes.deleteNote(msg.id);
        ws.send(JSON.stringify({ type: 'note_ack', ...result }));
        const allNotes = notes.listNotes(false);
        pushToClients({ action: 'notes_update', notes: allNotes });
        broadcastSSE('notes_update', { notes: allNotes });

      } else if (msg.type === 'save_draft') {
        const result = notes.saveDraft(msg.id, msg.content || '');
        ws.send(JSON.stringify({ type: 'draft_ack', ...result }));

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
app.use('/public', express.static(path.join(__dirname, 'public')));

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

// --- Health endpoints ---
app.get('/health/heart-rate', authCheck, (req, res) => {
  res.json({ entries: health.parseHeartRate() });
});

app.post('/health/heart-rate', authCheck, (req, res) => {
  const { date, bpm } = req.body;
  if (!date || bpm == null) return res.status(400).json({ error: 'date and bpm required' });
  const result = health.addHeartRate(date, parseInt(bpm, 10));
  if (result.ok) pushToClients({ action: 'health_data', heartRate: health.parseHeartRate(), bloodPressure: health.parseBloodPressure() });
  res.json(result);
});

app.get('/health/blood-pressure', authCheck, (req, res) => {
  res.json({ entries: health.parseBloodPressure() });
});

app.post('/health/blood-pressure', authCheck, (req, res) => {
  const { date, systolic, diastolic } = req.body;
  if (!date || systolic == null || diastolic == null) return res.status(400).json({ error: 'date, systolic, and diastolic required' });
  const result = health.addBloodPressure(date, parseInt(systolic, 10), parseInt(diastolic, 10));
  if (result.ok) pushToClients({ action: 'health_data', heartRate: health.parseHeartRate(), bloodPressure: health.parseBloodPressure() });
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

// --- Notes API ---

function notesUpdate() {
  const allNotes = notes.listNotes(false);
  pushToClients({ action: 'notes_update', notes: allNotes });
  broadcastSSE('notes_update', { notes: allNotes });
}

app.get('/notes/settings', authCheck, (req, res) => {
  res.json(notes.getSettings());
});

app.put('/notes/settings', authCheck, (req, res) => {
  const result = notes.saveSettings(req.body || {});
  res.json(result);
});

app.get('/notes', authCheck, (req, res) => {
  const includeArchived = req.query.archived === 'true';
  let list = notes.listNotes(includeArchived);
  if (req.query.tag) {
    const tag = req.query.tag.toLowerCase();
    list = list.filter(m => (m.tags || []).some(t => t.toLowerCase().includes(tag)));
  }
  if (req.query.show != null) {
    const show = req.query.show === 'true';
    list = list.filter(m => m.show === show);
  }
  if (req.query.search) {
    const q = req.query.search.toLowerCase();
    list = list.filter(m => m.name.toLowerCase().includes(q) || (m.tags || []).some(t => t.toLowerCase().includes(q)));
  }
  res.json({ notes: list });
});

app.post('/notes', authCheck, (req, res) => {
  const { name, content, tags, priority, show, createdBy } = req.body || {};
  const result = notes.createNote(name || null, content || '', { tags, priority, show, createdBy });
  notesUpdate();
  res.json(result);
});

app.get('/notes/:id', authCheck, (req, res) => {
  const note = notes.getNote(req.params.id);
  if (!note) return res.status(404).json({ error: 'not found' });
  res.json(note);
});

app.put('/notes/:id', authCheck, (req, res) => {
  const { content, ...meta } = req.body || {};
  const result = notes.updateNote(req.params.id, content, meta);
  if (!result) return res.status(404).json({ error: 'not found' });
  notesUpdate();
  res.json(result);
});

app.delete('/notes/:id', authCheck, (req, res) => {
  if (!req.body?.confirmed) return res.status(400).json({ error: 'confirmed required' });
  const result = notes.deleteNote(req.params.id);
  if (!result.ok) return res.status(404).json(result);
  notesUpdate();
  res.json(result);
});

app.post('/notes/:id/archive', authCheck, (req, res) => {
  const result = notes.archiveNote(req.params.id);
  if (!result.ok) return res.status(404).json(result);
  notesUpdate();
  res.json(result);
});

app.post('/notes/:id/unarchive', authCheck, (req, res) => {
  const result = notes.unarchiveNote(req.params.id);
  if (!result.ok) return res.status(404).json(result);
  notesUpdate();
  res.json(result);
});

app.get('/notes/:id/draft', authCheck, (req, res) => {
  const draft = notes.getDraft(req.params.id);
  if (!draft) return res.status(404).json({ error: 'no draft' });
  res.json(draft);
});

app.post('/notes/:id/draft', authCheck, (req, res) => {
  const result = notes.saveDraft(req.params.id, req.body?.content || '');
  res.json(result);
});

app.delete('/notes/:id/draft', authCheck, (req, res) => {
  const result = notes.deleteDraft(req.params.id);
  res.json(result);
});

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
    },
    heartRate: health.parseHeartRate(),
    bloodPressure: health.parseBloodPressure(),
    notes: notes.listNotes(false),
    noteSettings: notes.getSettings()
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
  .cat-tile { background: var(--surface2); border-radius: 8px; padding: 8px 6px; text-align: center; border: 2px solid transparent; transition: border-color 0.2s; }
  .cat-tile.outside { border-color: var(--yellow); }
  .cat-tile.inside { border-color: var(--green); }
  .cat-tile.unknown { border-color: var(--muted); }
  .cat-name { font-size: 0.8rem; font-weight: 600; margin-top: 5px; }
  .cat-state { font-size: 0.65rem; color: var(--muted); margin-top: 2px; }
  .cat-img { width: 64px; height: 64px; border-radius: 50%; object-fit: cover; display: block; margin: 0 auto; }
  .cat-img-placeholder { font-size: 1.6rem; line-height: 64px; }
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

  <!-- Health Card -->
  <div class="card" style="grid-column: 1 / -1" id="health-card">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;flex-wrap:wrap;gap:8px">
      <h2 style="margin:0">🏥 Health</h2>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <button class="btn secondary" id="hshow-weight" onclick="toggleHealthSeries('weight')" style="padding:3px 8px;font-size:0.75rem">⚖️ Weight</button>
        <button class="btn secondary" id="hshow-heart" onclick="toggleHealthSeries('heart')" style="padding:3px 8px;font-size:0.75rem">❤️ Heart</button>
        <button class="btn secondary" id="hshow-bp" onclick="toggleHealthSeries('bp')" style="padding:3px 8px;font-size:0.75rem">🩺 BP</button>
        <button class="btn secondary" id="health-range-btn" onclick="cycleHealthRange()" style="padding:3px 8px;font-size:0.75rem">month</button>
        <button class="btn secondary" onclick="showHealthLog()" style="padding:3px 8px;font-size:0.75rem">+ Log</button>
        <button class="btn secondary" onclick="toggleHealthDetail()" style="padding:3px 8px;font-size:0.75rem" id="health-detail-btn">detail ▸</button>
      </div>
    </div>
    <canvas id="health-mini-canvas" height="120" style="width:100%;cursor:pointer" onclick="cycleHealthRange()"></canvas>
    <div id="health-latest" style="font-size:0.75rem;color:var(--muted);margin-top:6px">—</div>
    <div id="health-detail" style="display:none;margin-top:12px">
      <div style="font-size:0.75rem;color:var(--muted);margin-bottom:4px">⚖️ Weight (lbs)</div>
      <canvas id="health-weight-canvas" height="100" style="width:100%"></canvas>
      <div style="font-size:0.75rem;color:var(--muted);margin:8px 0 4px">❤️ Heart Rate (BPM)</div>
      <canvas id="health-heart-canvas" height="100" style="width:100%"></canvas>
      <div style="font-size:0.75rem;color:var(--muted);margin:8px 0 4px">🩺 Blood Pressure <span style="color:#2196f3">■</span> Systolic <span style="color:#00bcd4">■</span> Diastolic</div>
      <canvas id="health-bp-canvas" height="100" style="width:100%"></canvas>
    </div>
  </div>
<!-- Notes Card -->
<div class="card" style="grid-column: 1 / -1; margin-top: 16px" id="notes-card">
  <h2 style="display:flex;justify-content:space-between;align-items:center">
    📝 Notes
    <button class="btn" style="font-size:0.75rem;padding:4px 12px" onclick="openNewNoteModal()">+ New Note</button>
  </h2>
  <div id="notes-list-top">Loading...</div>
  <div style="margin-top:8px">
    <button class="btn secondary" style="font-size:0.75rem;padding:4px 12px;width:100%" onclick="toggleAllNotes()">All Notes ▾</button>
  </div>
  <div id="notes-all-section" style="display:none;margin-top:12px">
    <div style="display:flex;gap:8px;margin-bottom:8px">
      <input id="notes-search" class="input" placeholder="Search notes..." style="flex:1" oninput="renderNotes()">
      <input id="notes-tag-filter" class="input" placeholder="Tag filter..." style="flex:1" oninput="renderNotes()">
    </div>
    <div id="notes-list-all"></div>
  </div>
</div>
</div>

<!-- Note modal -->
<div id="note-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:200;align-items:center;justify-content:center">
  <div style="background:var(--surface);border-radius:12px;padding:24px;min-width:340px;max-width:700px;width:95%;border:1px solid var(--border);max-height:90vh;overflow-y:auto">
    <h3 id="note-modal-title" style="margin-bottom:12px">New Note</h3>
    <input id="note-modal-name" class="input" placeholder="Name (auto-generated if blank)" style="margin-bottom:10px">
    <textarea id="note-modal-content" class="input" rows="8" style="margin-bottom:10px;resize:vertical;font-family:monospace" placeholder="Content (markdown)"></textarea>
    <input id="note-modal-tags" class="input" placeholder="Tags (comma-separated)" style="margin-bottom:10px">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
      <label style="font-size:0.85rem">Priority (0–1):</label>
      <input id="note-modal-priority" class="input" type="number" min="0" max="1" step="0.01" value="0.5" style="width:80px">
    </div>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px">
      <input type="checkbox" id="note-modal-show" checked>
      <label for="note-modal-show" style="font-size:0.85rem">Show on home</label>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button class="btn secondary" onclick="closeNoteModal()">Cancel</button>
      <button class="btn" onclick="saveNoteModal()">Save</button>
    </div>
  </div>
</div>

<!-- Health log dialog -->
<div id="health-dialog" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:100;align-items:center;justify-content:center">
  <div style="background:var(--surface);border-radius:12px;padding:24px;min-width:300px;max-width:400px;width:90%;border:1px solid var(--border)">
    <h3 style="margin-bottom:12px">Log Health Data</h3>
    <div id="health-dialog-date" style="font-size:0.8rem;color:var(--muted);margin-bottom:12px"></div>
    <label style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><input type="checkbox" id="hlog-weight-chk"> ⚖️ Weight</label>
    <div id="hlog-weight-fields" style="display:none;margin-bottom:10px">
      <input id="hlog-weight" class="input" type="number" step="0.1" placeholder="Weight (lbs)">
    </div>
    <label style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><input type="checkbox" id="hlog-heart-chk"> ❤️ Heart Rate</label>
    <div id="hlog-heart-fields" style="display:none;margin-bottom:10px">
      <input id="hlog-bpm" class="input" type="number" placeholder="BPM">
    </div>
    <label style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><input type="checkbox" id="hlog-bp-chk"> 🩺 Blood Pressure</label>
    <div id="hlog-bp-fields" style="display:none;margin-bottom:10px;display:none">
      <div style="display:flex;gap:8px">
        <input id="hlog-sys" class="input" type="number" placeholder="Systolic" style="flex:1">
        <input id="hlog-dia" class="input" type="number" placeholder="Diastolic" style="flex:1">
      </div>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
      <button class="btn secondary" onclick="closeHealthLog()">Cancel</button>
      <button class="btn" onclick="saveHealthEntry()">Save</button>
    </div>
  </div>
</div>

<script>
const TOKEN = '${token}';
const BASE = window.location.origin;

let state = { cats: {}, location: null, clients: 0, mute: null, tasks: { active: [], completed: [] }, health: { weight: [], heartRate: [], bloodPressure: [] }, notes: [], noteSettings: { maxShowOnHome: 5 } };

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
  es.addEventListener('health_data', e => {
    const d = JSON.parse(e.data);
    state.health.heartRate = d.heartRate || [];
    state.health.bloodPressure = d.bloodPressure || [];
    renderHealth();
  });
  es.addEventListener('notes_update', e => {
    const d = JSON.parse(e.data);
    state.notes = d.notes || [];
    renderNotes();
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
  if (d.notes !== undefined) state.notes = d.notes;
  if (d.noteSettings !== undefined) state.noteSettings = d.noteSettings;
  if (d.heartRate !== undefined) state.health.heartRate = d.heartRate;
  if (d.bloodPressure !== undefined) state.health.bloodPressure = d.bloodPressure;
  render();
  renderTasks();
  renderHealth();
  renderNotes();
}

const CAT_EMOJI = { Ty:'🖤', GentlemanMustachios:'🎩', Nocci:'🍊', Nommy:'🧡', Smoresy:'💜', Cay:'🐾' };
const CAT_IMG = name => {
  const key = name.toLowerCase().replace(/\\s+/g,'');
  return \`/public/cats/cat_\${key}.jpg\`;
};

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
      const imgSrc = CAT_IMG(name);
      const q = name.replace(/"/g, '&quot;'); // safe for HTML attribute double-quote context
      const btnHtml = !isOutdoorOnly
        ? '<div style="display:flex;gap:4px;margin-top:6px;justify-content:center">'
          + '<button class="state-btn' + (st==='inside'?' active-btn':'') + '" onclick="setCatState(&quot;' + q + '&quot;,&quot;inside&quot;)">in</button>'
          + '<button class="state-btn' + (st==='outside'?' active-btn':'') + '" onclick="setCatState(&quot;' + q + '&quot;,&quot;outside&quot;)">out</button>'
          + '<button class="state-btn' + (st==='unknown'?' active-btn':'') + '" onclick="setCatState(&quot;' + q + '&quot;,&quot;unknown&quot;)">?</button>'
          + '</div>'
        : '<div style="font-size:0.65rem;color:var(--muted);margin-top:4px">outdoor</div>';
      return '<div class="cat-tile ' + st + '">'
        + '<img class="cat-img" src="' + imgSrc + '" alt="' + name + '"'
        + ' onerror="this.style.display=&quot;none&quot;;this.nextElementSibling.style.display=&quot;block&quot;">'
        + '<div class="cat-img-placeholder" style="display:none">' + emoji + '</div>'
        + '<div class="cat-name">' + name + '</div>'
        + '<div class="cat-state">' + st + (ago ? ' · '+ago : '') + '</div>'
        + btnHtml
        + '</div>';
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

// ---- Health graph ----
let weightEntries = []; // kept for weight-only initial fetch
let healthRange = 'month';
const HEALTH_DAYS = { week: 7, month: 30, year: 365 };
let healthSeriesVis = { weight: true, heart: true, bp: true };
let healthDetailVisible = false;

function loadWeight() {
  api('GET', '/weight/history').then(d => {
    state.health.weight = d.entries || [];
    weightEntries = state.health.weight;
    renderHealth();
  });
}

function cycleHealthRange() {
  healthRange = healthRange === 'week' ? 'month' : healthRange === 'month' ? 'year' : 'week';
  document.getElementById('health-range-btn').textContent = healthRange;
  renderHealth();
}

// Keep old alias for any remaining calls
function cycleWeightRange() { cycleHealthRange(); }

function toggleHealthSeries(s) {
  healthSeriesVis[s] = !healthSeriesVis[s];
  const btn = document.getElementById('hshow-' + s);
  if (btn) btn.style.opacity = healthSeriesVis[s] ? '1' : '0.4';
  renderHealth();
}

function toggleHealthDetail() {
  healthDetailVisible = !healthDetailVisible;
  document.getElementById('health-detail').style.display = healthDetailVisible ? 'block' : 'none';
  document.getElementById('health-detail-btn').textContent = healthDetailVisible ? 'detail ▾' : 'detail ▸';
  if (healthDetailVisible) renderHealthDetail();
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

  // Time-axis: x proportional to date within [cutoff, today]
  const today = new Date(); today.setHours(0,0,0,0);
  const axisStartMs = cutoff.getTime();
  const axisRangeMs = today.getTime() - axisStartMs || 1;
  const xOfDate = dateStr => {
    const d = new Date(dateStr + 'T00:00:00'); 
    return padL + ((d.getTime() - axisStartMs) / axisRangeMs) * gW;
  };
  const yOf = w => padT + gH - ((w - minW) / rangeW) * gH;

  // Grid lines + Y labels
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

  // Line — gaps where data is missing are visually apparent
  if (filtered.length > 1) {
    ctx.beginPath();
    ctx.strokeStyle = '#bb86fc';
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    filtered.forEach((e, i) => {
      i === 0 ? ctx.moveTo(xOfDate(e.date), yOf(e.weight)) : ctx.lineTo(xOfDate(e.date), yOf(e.weight));
    });
    ctx.stroke();
  }

  // Dots
  const todayStr = today.toISOString().slice(0, 10);
  filtered.forEach(e => {
    const x = xOfDate(e.date), y = yOf(e.weight);
    const isToday = e.date === todayStr;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = isToday ? '#4caf50' : '#bb86fc';
    ctx.fill();
    ctx.strokeStyle = '#121212'; ctx.lineWidth = 1.5;
    ctx.stroke();
  });

  // X labels: start, mid, end of the time window (fixed axis dates, not entry positions)
  ctx.fillStyle = '#888';
  ctx.font = '8px sans-serif';
  const midDate = new Date(axisStartMs + axisRangeMs / 2);
  [
    { d: cutoff,  align: 'left' },
    { d: midDate, align: 'center' },
    { d: today,   align: 'right' }
  ].forEach(({ d, align }) => {
    const label = (d.getMonth() + 1) + '/' + d.getDate();
    const x = padL + ((d.getTime() - axisStartMs) / axisRangeMs) * gW;
    ctx.textAlign = align;
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
  if (isNaN(w)) { alert('Enter a valid weight'); return; }
  api('POST', '/weight/entry', { date: today, weight: w, notes: '' })
    .then(d => { if (d.ok) { closeWeightDialog(); loadWeight(); } });
}

// ---- Health rendering ----

function drawHealthCanvas(canvas, entries, colorHex, valueKey, labelText) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = canvas.offsetHeight * dpr;
  ctx.scale(dpr, dpr);
  const W = rect.width, H = canvas.offsetHeight;

  const today = new Date(); today.setHours(0,0,0,0);
  const cutoff = new Date(today.getTime() - HEALTH_DAYS[healthRange] * 86400000);
  const filtered = entries.filter(e => new Date(e.date + 'T00:00:00') >= cutoff)
    .sort((a,b) => a.date.localeCompare(b.date));

  if (filtered.length === 0) {
    ctx.fillStyle = '#555'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(labelText + ': no data', W/2, H/2);
    return;
  }

  const padL = 38, padR = 8, padT = 6, padB = 16;
  const gW = W - padL - padR, gH = H - padT - padB;
  const axisStartMs = cutoff.getTime(), axisRangeMs = today.getTime() - axisStartMs || 1;
  const vals = filtered.map(e => e[valueKey]);
  const minV = Math.floor(Math.min(...vals) - 2), maxV = Math.ceil(Math.max(...vals) + 2);
  const rangeV = maxV - minV || 1;
  const xOf = d => padL + ((new Date(d+'T00:00:00').getTime() - axisStartMs) / axisRangeMs) * gW;
  const yOf = v => padT + gH - ((v - minV) / rangeV) * gH;

  ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 0.5;
  ctx.fillStyle = '#777'; ctx.font = '8px sans-serif'; ctx.textAlign = 'right';
  for (let i = 0; i <= 3; i++) {
    const val = minV + (rangeV * i / 3), y = yOf(val);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W-padR, y); ctx.stroke();
    ctx.fillText(Math.round(val), padL-2, y+3);
  }

  if (filtered.length > 1) {
    ctx.beginPath(); ctx.strokeStyle = colorHex; ctx.lineWidth = 2;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    filtered.forEach((e,i) => i===0 ? ctx.moveTo(xOf(e.date),yOf(e[valueKey])) : ctx.lineTo(xOf(e.date),yOf(e[valueKey])));
    ctx.stroke();
  }
  filtered.forEach(e => {
    ctx.beginPath(); ctx.arc(xOf(e.date), yOf(e[valueKey]), 3, 0, Math.PI*2);
    ctx.fillStyle = colorHex; ctx.fill();
  });

  const last = filtered[filtered.length-1];
  return last[valueKey];
}

function renderHealth() {
  const h = state.health || {};
  const today = new Date(); today.setHours(0,0,0,0);
  const cutoff = new Date(today.getTime() - HEALTH_DAYS[healthRange] * 86400000);

  const canvas = document.getElementById('health-mini-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = 120 * dpr;
  ctx.scale(dpr, dpr);
  const W = rect.width, H = 120;

  const padL = 8, padR = 8, padT = 8, padB = 8;
  const gW = W - padL - padR, gH = H - padT - padB;
  const axisStartMs = cutoff.getTime(), axisRangeMs = today.getTime() - axisStartMs || 1;
  const xOf = d => padL + ((new Date(d+'T00:00:00').getTime() - axisStartMs) / axisRangeMs) * gW;

  // Each series independently scaled
  function drawSeries(entries, valueKey, color, isVisible) {
    if (!isVisible || !entries || entries.length === 0) return;
    const filtered = entries.filter(e => new Date(e.date+'T00:00:00') >= cutoff).sort((a,b)=>a.date.localeCompare(b.date));
    if (filtered.length === 0) return;
    const vals = filtered.map(e => e[valueKey]);
    const minV = Math.min(...vals)-2, maxV = Math.max(...vals)+2, rV = maxV-minV||1;
    const yOf = v => padT + gH - ((v-minV)/rV)*gH;
    if (filtered.length > 1) {
      ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin='round'; ctx.lineCap='round';
      filtered.forEach((e,i) => i===0?ctx.moveTo(xOf(e.date),yOf(e[valueKey])):ctx.lineTo(xOf(e.date),yOf(e[valueKey])));
      ctx.stroke();
    }
    filtered.forEach(e => { ctx.beginPath(); ctx.arc(xOf(e.date),yOf(e[valueKey]),3,0,Math.PI*2); ctx.fillStyle=color; ctx.fill(); });
  }

  ctx.fillStyle = 'var(--surface2)';
  ctx.fillRect(0,0,W,H);
  drawSeries(h.weight||[], 'weight', '#BB86FC', healthSeriesVis.weight);
  drawSeries(h.heartRate||[], 'bpm', '#F44336', healthSeriesVis.heart);
  drawSeries(h.bloodPressure||[], 'systolic', '#2196F3', healthSeriesVis.bp);
  drawSeries(h.bloodPressure||[], 'diastolic', '#00BCD4', healthSeriesVis.bp);

  const latestEl = document.getElementById('health-latest');
  if (latestEl) {
    const parts = [];
    const lw = (h.weight||[]).slice(-1)[0]; if (lw) parts.push(lw.weight+' lbs');
    const lh = (h.heartRate||[]).slice(-1)[0]; if (lh) parts.push(lh.bpm+' bpm');
    const lb = (h.bloodPressure||[]).slice(-1)[0]; if (lb) parts.push(lb.systolic+'/'+lb.diastolic);
    latestEl.textContent = parts.length ? parts.join(' · ') : '';
  }

  if (healthDetailVisible) renderHealthDetail();
}

function renderHealthDetail() {
  const h = state.health || {};
  drawHealthCanvas(document.getElementById('health-weight-canvas'), h.weight||[], '#BB86FC', 'weight', 'Weight');
  drawHealthCanvas(document.getElementById('health-heart-canvas'), h.heartRate||[], '#F44336', 'bpm', 'Heart Rate');
  // BP: two series on one canvas
  const bpCanvas = document.getElementById('health-bp-canvas');
  if (bpCanvas) {
    const bpData = h.bloodPressure || [];
    const today = new Date(); today.setHours(0,0,0,0);
    const cutoff = new Date(today.getTime() - HEALTH_DAYS[healthRange] * 86400000);
    const filtered = bpData.filter(e => new Date(e.date+'T00:00:00') >= cutoff).sort((a,b)=>a.date.localeCompare(b.date));
    if (filtered.length === 0) {
      const ctx = bpCanvas.getContext('2d');
      const dpr = window.devicePixelRatio||1;
      bpCanvas.width = bpCanvas.offsetWidth*dpr; bpCanvas.height = bpCanvas.offsetHeight*dpr;
      ctx.scale(dpr,dpr); ctx.fillStyle='#555'; ctx.font='11px sans-serif'; ctx.textAlign='center';
      ctx.fillText('Blood Pressure: no data', bpCanvas.offsetWidth/2, bpCanvas.offsetHeight/2);
    } else {
      // Draw both systolic and diastolic scaled together
      const ctx = bpCanvas.getContext('2d');
      const dpr = window.devicePixelRatio||1;
      const rect = bpCanvas.getBoundingClientRect();
      bpCanvas.width = rect.width*dpr; bpCanvas.height = bpCanvas.offsetHeight*dpr;
      ctx.scale(dpr,dpr);
      const W = rect.width, H = bpCanvas.offsetHeight;
      const padL=38,padR=8,padT=6,padB=16,gW=W-padL-padR,gH=H-padT-padB;
      const axisStartMs=cutoff.getTime(),axisRangeMs=today.getTime()-axisStartMs||1;
      const xOf = d => padL+((new Date(d+'T00:00:00').getTime()-axisStartMs)/axisRangeMs)*gW;
      const allVals=[...filtered.map(e=>e.systolic),...filtered.map(e=>e.diastolic)];
      const minV=Math.floor(Math.min(...allVals)-2),maxV=Math.ceil(Math.max(...allVals)+2),rV=maxV-minV||1;
      const yOf=v=>padT+gH-((v-minV)/rV)*gH;
      ctx.strokeStyle='rgba(255,255,255,0.07)';ctx.lineWidth=0.5;
      ctx.fillStyle='#777';ctx.font='8px sans-serif';ctx.textAlign='right';
      for(let i=0;i<=3;i++){const val=minV+(rV*i/3),y=yOf(val);ctx.beginPath();ctx.moveTo(padL,y);ctx.lineTo(W-padR,y);ctx.stroke();ctx.fillText(Math.round(val),padL-2,y+3);}
      [['#2196F3','systolic'],['#00BCD4','diastolic']].forEach(([col,key])=>{
        ctx.beginPath();ctx.strokeStyle=col;ctx.lineWidth=2;ctx.lineJoin='round';ctx.lineCap='round';
        filtered.forEach((e,i)=>i===0?ctx.moveTo(xOf(e.date),yOf(e[key])):ctx.lineTo(xOf(e.date),yOf(e[key])));
        ctx.stroke();
        filtered.forEach(e=>{ctx.beginPath();ctx.arc(xOf(e.date),yOf(e[key]),3,0,Math.PI*2);ctx.fillStyle=col;ctx.fill();});
      });
    }
  }
}

function showHealthLog() {
  const dlg = document.getElementById('health-log-dialog');
  if (dlg) dlg.style.display = 'flex';
}
function closeHealthLog() {
  const dlg = document.getElementById('health-log-dialog'); if (dlg) dlg.style.display='none';
}
function saveHealthEntry() {
  const today = new Date().toISOString().slice(0,10);
  const promises = [];
  if (document.getElementById('hlog-weight-chk').checked) {
    const w = parseFloat(document.getElementById('hlog-weight').value);
    if (!isNaN(w)) promises.push(api('POST','/weight/entry',{date:today,weight:w,notes:''}).then(d=>{if(d.ok)loadWeight();}));
  }
  if (document.getElementById('hlog-heart-chk').checked) {
    const b = parseInt(document.getElementById('hlog-bpm').value);
    if (!isNaN(b)) promises.push(api('POST','/health/heart-rate',{date:today,bpm:b}));
  }
  if (document.getElementById('hlog-bp-chk').checked) {
    const s=parseInt(document.getElementById('hlog-sys').value),d2=parseInt(document.getElementById('hlog-dia').value);
    if (!isNaN(s)&&!isNaN(d2)) promises.push(api('POST','/health/blood-pressure',{date:today,systolic:s,diastolic:d2}));
  }
  Promise.all(promises).then(()=>closeHealthLog());
}

// (old weight-only dialog removed — use health log dialog instead)

// Refresh display every 10s — updates timestamps and client-side stall detection
setInterval(() => { render(); renderTasks(); }, 10000);

let taskExpanded = false;
const expandedTasks = new Set(); // task ids currently expanded

function toggleTaskExpand() {
  taskExpanded = !taskExpanded;
  document.getElementById('task-expand').style.display = taskExpanded ? 'block' : 'none';
  renderTaskList(); // populate immediately on open; no-op when closing (guard inside)
}

function toggleTask(id) {
  if (expandedTasks.has(id)) expandedTasks.delete(id);
  else expandedTasks.add(id);
  renderTaskList();
}

function renderTasks() {
  const tasks = state.tasks || { active: [], completed: [] };
  const all = [...(tasks.active || []), ...(tasks.completed || [])];

  // Compute counts with client-side stall detection
  const now = Math.floor(Date.now() / 1000);
  // Active tasks: detect stall by timeout. Completed tasks: running→failed (abandoned), never stalled.
  const effectiveStatus = (t, isCompleted) => {
    const s = t.status === 'success' ? 'complete' : t.status; // normalise legacy status
    if (isCompleted) return s === 'running' ? 'failed' : s;
    return (s === 'running' && t.timeoutAt && now > t.timeoutAt) ? 'stalled' : s;
  };

  const counts = { running: 0, stalled: 0, complete: 0, failed: 0 };
  (tasks.active || []).forEach(t => { const s = effectiveStatus(t, false); if (s in counts) counts[s]++; });
  (tasks.completed || []).forEach(t => { const s = effectiveStatus(t, true); if (s in counts) counts[s]++; });

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

  renderTaskList();
}

function renderTaskList() {
  if (!taskExpanded) return;
  const tasks = state.tasks || { active: [], completed: [] };
  const listEl = document.getElementById('task-list');
  const now = Math.floor(Date.now() / 1000);

  const effectiveStatus = (t, isCompleted) => {
    const s = t.status === 'success' ? 'complete' : t.status;
    if (isCompleted) return s === 'running' ? 'failed' : s;
    return (s === 'running' && t.timeoutAt && now > t.timeoutAt) ? 'stalled' : s;
  };

  const active = (tasks.active || []).slice().sort((a,b) => b.spawnedAt - a.spawnedAt);
  const recent = (tasks.completed || []).slice(-10).reverse();
  const all = [...active.map(t=>({t,isCompleted:false})), ...recent.map(t=>({t,isCompleted:true}))];

  if (all.length === 0) {
    listEl.innerHTML = '<div style="color:var(--muted);font-size:0.85rem;padding:4px 0">No tasks</div>';
    return;
  }

  const fmt = ts => ts ? new Date(ts * 1000).toLocaleString([], {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '—';
  const colors = { running:'#4caf50', stalled:'#ffc107', complete:'var(--muted)', failed:'#f44336' };
  const emojis = { running:'⚡', stalled:'⚠️', complete:'✅', failed:'❌' };

  let html = '';
  let lastSection = null;

  all.forEach(({t, isCompleted}) => {
    const section = isCompleted ? 'RECENT' : 'ACTIVE';
    if (section !== lastSection && active.length && recent.length) {
      if (lastSection !== null)
        html += '<div style="font-size:0.7rem;color:var(--muted);margin-top:6px;margin-bottom:2px;letter-spacing:0.05em">RECENT</div>';
      lastSection = section;
    }

    const st = effectiveStatus(t, isCompleted);
    const open = expandedTasks.has(t.id);
    const remaining = st === 'running' && t.timeoutAt ? t.timeoutAt - now : null;
    const safeId = t.id.replace(/[^a-z0-9-]/gi, '');

    html += \`<div style="background:var(--surface2);border-radius:8px;overflow:hidden;opacity:\${isCompleted?0.65:1}">
      <div onclick="toggleTask('\${safeId}')" style="
        display:flex;justify-content:space-between;align-items:center;
        padding:8px 12px;cursor:pointer;user-select:none;
      ">
        <span style="font-weight:600;font-size:0.82rem;display:flex;align-items:center;gap:6px">
          \${emojis[st]||'❓'} \${t.label}
        </span>
        <span style="display:flex;align-items:center;gap:8px">
          <span style="font-size:0.68rem;font-weight:700;color:\${colors[st]||'var(--muted)'}">\${st.toUpperCase()}</span>
          <span style="color:var(--muted);font-size:0.8rem">\${open ? '▾' : '▸'}</span>
        </span>
      </div>
      \${open ? \`<div style="padding:0 12px 10px;border-top:1px solid rgba(255,255,255,0.06)">
        \${t.description ? \`<div style="font-size:0.75rem;color:var(--muted);margin-top:6px;margin-bottom:3px">\${t.description}</div>\` : ''}
        \${t.notes ? \`<div style="font-size:0.7rem;font-family:monospace;color:var(--muted);opacity:0.8;margin-bottom:4px">\${t.notes}</div>\` : ''}
        <div style="display:flex;gap:10px;font-size:0.68rem;color:var(--muted);margin-top:4px">
          <span>type:\${t.type}</span>
          <span>spawned:\${fmt(t.spawnedAt)}</span>
          \${t.priorFailures > 0 ? '<span style="color:#ffc107">' + t.priorFailures + ' prior failure' + (t.priorFailures>1?'s':'') + '</span>' : ''}
          \${remaining !== null && remaining > 0 ? \`<span style="color:\${remaining<300?'#ffc107':'var(--muted)'}">timeout:\${Math.floor(remaining/60)}m</span>\` : ''}
        </div>
      </div>\` : ''}
    </div>\`;
  });

  listEl.innerHTML = html;
}

// Prefetch tasks immediately on load so panel shows without waiting for SSE init
Promise.all([
  api('GET', '/tasks'),
  api('GET', '/tasks/completed')
]).then(([active, completed]) => {
  state.tasks = {
    active: active.tasks || [],
    completed: (completed.tasks || []).slice(-20)
  };
  renderTasks();
}).catch(() => {});


// ── Notes ────────────────────────────────────────────────────────────────────
let notesExpanded = false;
let editingNoteId = null;

function toggleAllNotes() {
  notesExpanded = !notesExpanded;
  document.getElementById('notes-all-section').style.display = notesExpanded ? 'block' : 'none';
  renderNotes();
}

function renderNotes() {
  const topEl = document.getElementById('notes-list-top');
  const allEl = document.getElementById('notes-list-all');
  const search = (document.getElementById('notes-search')?.value || '').toLowerCase();
  const tagF = (document.getElementById('notes-tag-filter')?.value || '').toLowerCase();

  const sorted = (state.notes || [])
    .filter(n => !n.archived)
    .slice()
    .sort((a,b) => (b.priority||0.5) - (a.priority||0.5) || b.modifiedAt - a.modifiedAt);

  const showNotes = sorted.filter(n => n.show !== false).slice(0, state.noteSettings?.maxShowOnHome || 5);

  const fmtDate = ms => ms ? new Date(ms).toLocaleDateString([], {month:'numeric',day:'numeric',year:'2-digit'}) : '';
  const prioColor = p => p > 0.7 ? '#4caf50' : p >= 0.3 ? '#ffc107' : '#888';
  const renderTags = tags => (tags||[]).map(t => '<span class="tag" style="margin-right:3px">' + t + '</span>').join('');

  const renderItem = n => '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);cursor:pointer" onclick="openEditNoteModal(&quot;' + n.id + '&quot;)">' +
    '<span style="width:10px;height:10px;border-radius:50%;background:' + prioColor(n.priority||0.5) + ';flex-shrink:0;display:inline-block"></span>' +
    '<div style="flex:1;min-width:0">' +
      '<div style="font-weight:600;font-size:0.9rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + n.name + '</div>' +
      '<div style="font-size:0.7rem;color:var(--muted)">' + renderTags(n.tags) + ' ' + fmtDate(n.modifiedAt) + '</div>' +
    '</div>' +
  '</div>';

  if (showNotes.length === 0) {
    topEl.innerHTML = '<div style="color:var(--muted);font-size:0.85rem">No notes yet. Create one!</div>';
  } else {
    topEl.innerHTML = showNotes.map(renderItem).join('');
  }

  if (notesExpanded && allEl) {
    let filtered = sorted;
    if (search) filtered = filtered.filter(n => n.name.toLowerCase().includes(search) || (n.tags||[]).some(t=>t.toLowerCase().includes(search)));
    if (tagF) filtered = filtered.filter(n => (n.tags||[]).some(t=>t.toLowerCase().includes(tagF)));
    allEl.innerHTML = filtered.length ? filtered.map(renderItem).join('') : '<div style="color:var(--muted);font-size:0.85rem">No matching notes</div>';
  }
}

function openNewNoteModal() {
  editingNoteId = null;
  document.getElementById('note-modal-title').textContent = 'New Note';
  document.getElementById('note-modal-name').value = '';
  document.getElementById('note-modal-content').value = '';
  document.getElementById('note-modal-tags').value = '';
  document.getElementById('note-modal-priority').value = '0.5';
  document.getElementById('note-modal-show').checked = true;
  document.getElementById('note-modal').style.display = 'flex';
}

function openEditNoteModal(id) {
  editingNoteId = id;
  document.getElementById('note-modal-title').textContent = 'Edit Note';
  document.getElementById('note-modal').style.display = 'flex';
  // Fetch full note content
  api('GET', '/notes/' + id).then(d => {
    const m = d.meta || {};
    document.getElementById('note-modal-name').value = m.name || id;
    document.getElementById('note-modal-content').value = d.content || '';
    document.getElementById('note-modal-tags').value = (m.tags||[]).join(', ');
    document.getElementById('note-modal-priority').value = (m.priority != null ? m.priority : 0.5).toFixed(2);
    document.getElementById('note-modal-show').checked = m.show !== false;
  }).catch(() => {});
}

function closeNoteModal() {
  editingNoteId = null;
  document.getElementById('note-modal').style.display = 'none';
}

function saveNoteModal() {
  const name = document.getElementById('note-modal-name').value.trim() || null;
  const content = document.getElementById('note-modal-content').value;
  const tagsRaw = document.getElementById('note-modal-tags').value;
  const tags = tagsRaw ? tagsRaw.split(',').map(t=>t.trim()).filter(Boolean) : [];
  const priority = parseFloat(document.getElementById('note-modal-priority').value) || 0.5;
  const show = document.getElementById('note-modal-show').checked;

  if (editingNoteId) {
    api('PUT', '/notes/' + editingNoteId, { content, name, tags, priority, show })
      .then(() => { closeNoteModal(); })
      .catch(() => alert('Save failed'));
  } else {
    api('POST', '/notes', { name, content, tags, priority, show })
      .then(() => { closeNoteModal(); })
      .catch(() => alert('Create failed'));
  }
}

// Load notes on page load
api('GET', '/notes').then(d => {
  state.notes = d.notes || [];
  renderNotes();
}).catch(() => {});

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
