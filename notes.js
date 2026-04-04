'use strict';

const fs = require('fs');
const path = require('path');

const NOTES_DIR = '/home/claw/.openclaw/workspace/notes';
const ARCHIVE_DIR = path.join(NOTES_DIR, 'archive');
const DRAFTS_DIR = path.join(NOTES_DIR, 'drafts');
const INDEX_PATH = path.join(NOTES_DIR, 'index.json');
const SETTINGS_PATH = path.join(NOTES_DIR, 'settings.json');

// Ensure directories exist
[NOTES_DIR, ARCHIVE_DIR, DRAFTS_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// Initialize index if missing
if (!fs.existsSync(INDEX_PATH)) {
  fs.writeFileSync(INDEX_PATH, JSON.stringify([], null, 2));
}

// ── Atomic write helper ──────────────────────────────────────────────────────

function atomicWrite(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

// ── Index management ──────────────────────────────────────────────────────────

function readIndex() {
  try { return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8')); }
  catch (_) { return []; }
}

function writeIndex(arr) {
  atomicWrite(INDEX_PATH, arr);
}

function rebuildIndex() {
  const metas = [];
  // Active notes
  for (const f of fs.readdirSync(NOTES_DIR)) {
    if (!f.endsWith('.meta.json')) continue;
    try { metas.push(JSON.parse(fs.readFileSync(path.join(NOTES_DIR, f), 'utf8'))); }
    catch (_) {}
  }
  // Archived notes
  for (const f of fs.readdirSync(ARCHIVE_DIR)) {
    if (!f.endsWith('.meta.json')) continue;
    try { metas.push(JSON.parse(fs.readFileSync(path.join(ARCHIVE_DIR, f), 'utf8'))); }
    catch (_) {}
  }
  metas.sort((a, b) => b.modifiedAt - a.modifiedAt);
  writeIndex(metas);
  return metas;
}

// ── ID generation ─────────────────────────────────────────────────────────────

function todayPrefix() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function generateId() {
  const prefix = todayPrefix();
  const index = readIndex();
  // Find highest NNN for today
  let max = 0;
  for (const meta of index) {
    if (meta.id && meta.id.startsWith(prefix + '.')) {
      const n = parseInt(meta.id.slice(prefix.length + 1), 10);
      if (!isNaN(n) && n > max) max = n;
    }
  }
  // Also check active + archive dirs directly to avoid race conditions
  for (const f of [...fs.readdirSync(NOTES_DIR), ...fs.readdirSync(ARCHIVE_DIR)]) {
    if (!f.endsWith('.meta.json')) continue;
    const id = f.replace('.meta.json', '');
    if (id.startsWith(prefix + '.')) {
      const n = parseInt(id.slice(prefix.length + 1), 10);
      if (!isNaN(n) && n > max) max = n;
    }
  }
  return `${prefix}.${String(max + 1).padStart(3, '0')}`;
}

// ── File paths ────────────────────────────────────────────────────────────────

function metaPath(id, archived) {
  return archived
    ? path.join(ARCHIVE_DIR, `${id}.meta.json`)
    : path.join(NOTES_DIR, `${id}.meta.json`);
}

function contentPath(id, archived) {
  return archived
    ? path.join(ARCHIVE_DIR, `${id}.md`)
    : path.join(NOTES_DIR, `${id}.md`);
}

function findNote(id) {
  // Check active first, then archive
  if (fs.existsSync(path.join(NOTES_DIR, `${id}.meta.json`))) {
    return { archived: false };
  }
  if (fs.existsSync(path.join(ARCHIVE_DIR, `${id}.meta.json`))) {
    return { archived: true };
  }
  return null;
}

function readMeta(id, archived) {
  try { return JSON.parse(fs.readFileSync(metaPath(id, archived), 'utf8')); }
  catch (_) { return null; }
}

function updateMetaInIndex(meta) {
  const index = readIndex();
  const i = index.findIndex(m => m.id === meta.id);
  if (i >= 0) index[i] = meta; else index.push(meta);
  writeIndex(index);
}

function removeFromIndex(id) {
  const index = readIndex().filter(m => m.id !== id);
  writeIndex(index);
}

// ── Public API ────────────────────────────────────────────────────────────────

function listNotes(includeArchived = false) {
  const index = readIndex();
  if (includeArchived) return index;
  return index.filter(m => !m.archived);
}

function getNote(id) {
  const loc = findNote(id);
  if (!loc) return null;
  const meta = readMeta(id, loc.archived);
  if (!meta) return null;
  let content = '';
  try { content = fs.readFileSync(contentPath(id, loc.archived), 'utf8'); }
  catch (_) {}
  return { meta, content };
}

function createNote(name, content, extraMeta = {}) {
  const id = name || generateId();
  // Ensure no conflict
  let finalId = id;
  if (findNote(finalId)) {
    // Increment suffix
    const base = finalId.includes('.') ? finalId.split('.').slice(0, -1).join('.') : finalId;
    let suffix = 2;
    while (findNote(`${base}.${String(suffix).padStart(3, '0')}`)) suffix++;
    finalId = `${base}.${String(suffix).padStart(3, '0')}`;
  }

  const now = Date.now();
  const meta = {
    id: finalId,
    name: finalId,
    tags: extraMeta.tags || [],
    priority: extraMeta.priority != null ? extraMeta.priority : 0.5,
    show: extraMeta.show != null ? extraMeta.show : true,
    archived: false,
    createdAt: now,
    modifiedAt: now,
    createdBy: extraMeta.createdBy || 'user',
    version: 1
  };

  atomicWrite(contentPath(finalId, false), content || '');
  atomicWrite(metaPath(finalId, false), meta);
  updateMetaInIndex(meta);
  return { id: finalId, meta };
}

function updateNote(id, content, extraMeta = {}) {
  const loc = findNote(id);
  if (!loc) return null;

  const meta = readMeta(id, loc.archived);
  if (!meta) return null;

  const now = Date.now();
  const updated = {
    ...meta,
    ...extraMeta,
    id,
    name: extraMeta.name || meta.name,
    modifiedAt: now,
    version: (meta.version || 1) + 1
  };

  atomicWrite(contentPath(id, loc.archived), content != null ? content : '');
  atomicWrite(metaPath(id, loc.archived), updated);
  updateMetaInIndex(updated);
  return { meta: updated };
}

function archiveNote(id) {
  const loc = findNote(id);
  if (!loc || loc.archived) return { ok: false, error: 'not found or already archived' };

  const meta = readMeta(id, false);
  if (!meta) return { ok: false, error: 'meta not found' };

  let content = '';
  try { content = fs.readFileSync(contentPath(id, false), 'utf8'); } catch (_) {}

  // Move files
  atomicWrite(contentPath(id, true), content);
  atomicWrite(metaPath(id, true), { ...meta, archived: true, modifiedAt: Date.now() });

  try { fs.unlinkSync(contentPath(id, false)); } catch (_) {}
  try { fs.unlinkSync(metaPath(id, false)); } catch (_) {}

  const updatedMeta = readMeta(id, true);
  updateMetaInIndex(updatedMeta);
  return { ok: true };
}

function unarchiveNote(id) {
  const loc = findNote(id);
  if (!loc || !loc.archived) return { ok: false, error: 'not found or not archived' };

  const meta = readMeta(id, true);
  if (!meta) return { ok: false, error: 'meta not found' };

  let content = '';
  try { content = fs.readFileSync(contentPath(id, true), 'utf8'); } catch (_) {}

  atomicWrite(contentPath(id, false), content);
  atomicWrite(metaPath(id, false), { ...meta, archived: false, modifiedAt: Date.now() });

  try { fs.unlinkSync(contentPath(id, true)); } catch (_) {}
  try { fs.unlinkSync(metaPath(id, true)); } catch (_) {}

  const updatedMeta = readMeta(id, false);
  updateMetaInIndex(updatedMeta);
  return { ok: true };
}

function deleteNote(id) {
  const loc = findNote(id);
  if (!loc) return { ok: false, error: 'not found' };

  try { fs.unlinkSync(contentPath(id, loc.archived)); } catch (_) {}
  try { fs.unlinkSync(metaPath(id, loc.archived)); } catch (_) {}
  // Also delete draft if any
  try { fs.unlinkSync(path.join(DRAFTS_DIR, `${id}.draft.json`)); } catch (_) {}

  removeFromIndex(id);
  return { ok: true };
}

// ── Drafts ────────────────────────────────────────────────────────────────────

function saveDraft(id, content) {
  const draft = { content, savedAt: Date.now() };
  atomicWrite(path.join(DRAFTS_DIR, `${id}.draft.json`), draft);
  return { ok: true };
}

function getDraft(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DRAFTS_DIR, `${id}.draft.json`), 'utf8'));
  } catch (_) { return null; }
}

function deleteDraft(id) {
  try { fs.unlinkSync(path.join(DRAFTS_DIR, `${id}.draft.json`)); return { ok: true }; }
  catch (_) { return { ok: false, error: 'not found' }; }
}

// ── Settings ──────────────────────────────────────────────────────────────────

function getSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); }
  catch (_) { return { maxShowOnHome: 5 }; }
}

function saveSettings(settings) {
  atomicWrite(SETTINGS_PATH, settings);
  return { ok: true };
}

module.exports = {
  listNotes,
  getNote,
  createNote,
  updateNote,
  archiveNote,
  unarchiveNote,
  deleteNote,
  saveDraft,
  getDraft,
  deleteDraft,
  getSettings,
  saveSettings,
  rebuildIndex
};
