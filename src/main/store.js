'use strict';

/**
 * Хранилище заметок: один JSON-файл в папке пользователя.
 *
 * Запись на диск отложенная (debounce), атомарная (через временный файл)
 * и с резервной копией, чтобы заметки не терялись при сбое питания
 * или аварийном завершении.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COLORS = ['cream', 'peach', 'rose', 'honey', 'sage', 'lavender', 'latte'];
const DEFAULT_COLOR = 'cream';
const FONT_MIN = 11;
const FONT_MAX = 32;
const FONT_DEFAULT = 15;
const OPACITY_MIN = 0.4;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function sanitizeBounds(bounds) {
  if (!bounds || typeof bounds !== 'object') return null;
  const { x, y, width, height } = bounds;
  if (![x, y, width, height].every(isFiniteNumber)) return null;
  if (width < 50 || height < 50) return null;
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function normalizeNote(raw) {
  const now = Date.now();
  const note = raw && typeof raw === 'object' ? raw : {};
  return {
    id: typeof note.id === 'string' && note.id ? note.id : crypto.randomUUID(),
    title: typeof note.title === 'string' ? note.title : '',
    body: typeof note.body === 'string' ? note.body : '',
    color: COLORS.includes(note.color) ? note.color : DEFAULT_COLOR,
    pinned: Boolean(note.pinned),
    open: note.open === undefined ? true : Boolean(note.open),
    opacity: isFiniteNumber(note.opacity) ? clamp(note.opacity, OPACITY_MIN, 1) : 1,
    fontSize: isFiniteNumber(note.fontSize)
      ? clamp(Math.round(note.fontSize), FONT_MIN, FONT_MAX)
      : FONT_DEFAULT,
    bounds: sanitizeBounds(note.bounds),
    createdAt: isFiniteNumber(note.createdAt) ? note.createdAt : now,
    updatedAt: isFiniteNumber(note.updatedAt) ? note.updatedAt : now,
  };
}

/** Поля, которые можно менять через update(); всё остальное игнорируется. */
const EDITABLE = {
  title: (v) => (typeof v === 'string' ? v : undefined),
  body: (v) => (typeof v === 'string' ? v : undefined),
  color: (v) => (COLORS.includes(v) ? v : undefined),
  pinned: (v) => (typeof v === 'boolean' ? v : undefined),
  open: (v) => (typeof v === 'boolean' ? v : undefined),
  opacity: (v) => (isFiniteNumber(v) ? clamp(v, OPACITY_MIN, 1) : undefined),
  fontSize: (v) => (isFiniteNumber(v) ? clamp(Math.round(v), FONT_MIN, FONT_MAX) : undefined),
  bounds: (v) => sanitizeBounds(v) || undefined,
};

/** Изменение этих полей двигает дату «изменено» — перемещение окна её не трогает. */
const CONTENT_FIELDS = new Set(['title', 'body', 'color']);

class NotesStore {
  /**
   * @param {string} filePath путь к notes.json
   * @param {{ saveDelay?: number }} [options]
   */
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.backupPath = filePath.replace(/\.json$/i, '') + '.backup.json';
    this.saveDelay = options.saveDelay ?? 400;
    this.saveTimer = null;
    this.dirty = false;
    this.isFirstRun = false;
    this.data = { version: 1, settings: {}, notes: [] };
  }

  load() {
    const primary = this._readJson(this.filePath);
    if (primary.ok) {
      this._setData(primary.value);
      return this;
    }

    if (primary.exists) {
      // Файл повреждён: откладываем его в сторону и пробуем резервную копию.
      try {
        fs.renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
      } catch {
        /* не страшно */
      }
    }

    const backup = this._readJson(this.backupPath);
    if (backup.ok) {
      this._setData(backup.value);
      this.dirty = true;
      this.flush();
      return this;
    }

    this.isFirstRun = !primary.exists && !backup.exists;
    this.data = { version: 1, settings: {}, notes: [] };
    return this;
  }

  _readJson(file) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return { ok: false, exists: false };
    }
    try {
      const value = JSON.parse(text);
      if (!value || typeof value !== 'object' || !Array.isArray(value.notes)) {
        return { ok: false, exists: true };
      }
      return { ok: true, exists: true, value };
    } catch {
      return { ok: false, exists: true };
    }
  }

  _setData(value) {
    const seen = new Set();
    const notes = [];
    for (const raw of value.notes) {
      const note = normalizeNote(raw);
      if (seen.has(note.id)) continue;
      seen.add(note.id);
      notes.push(note);
    }
    this.data = {
      version: 1,
      settings: value.settings && typeof value.settings === 'object' ? value.settings : {},
      notes,
    };
  }

  /** Все заметки, свежие сверху. Возвращает копии. */
  list() {
    return this.data.notes
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((n) => ({ ...n, bounds: n.bounds ? { ...n.bounds } : null }));
  }

  get(id) {
    const note = this.data.notes.find((n) => n.id === id);
    return note ? { ...note, bounds: note.bounds ? { ...note.bounds } : null } : null;
  }

  has(id) {
    return this.data.notes.some((n) => n.id === id);
  }

  create(fields = {}) {
    const now = Date.now();
    const note = normalizeNote({ ...fields, id: undefined, createdAt: now, updatedAt: now });
    this.data.notes.push(note);
    this.scheduleSave();
    return this.get(note.id);
  }

  update(id, patch = {}) {
    const note = this.data.notes.find((n) => n.id === id);
    if (!note) return null;
    let changed = false;
    let contentChanged = false;
    for (const [key, value] of Object.entries(patch || {})) {
      const coerce = EDITABLE[key];
      if (!coerce) continue;
      const next = coerce(value);
      if (next === undefined) continue;
      const same =
        key === 'bounds' ? JSON.stringify(note.bounds) === JSON.stringify(next) : note[key] === next;
      if (same) continue;
      note[key] = next;
      changed = true;
      if (CONTENT_FIELDS.has(key)) contentChanged = true;
    }
    if (contentChanged) note.updatedAt = Date.now();
    if (changed) this.scheduleSave();
    return { note: this.get(id), changed, contentChanged };
  }

  remove(id) {
    const before = this.data.notes.length;
    this.data.notes = this.data.notes.filter((n) => n.id !== id);
    const removed = this.data.notes.length !== before;
    if (removed) this.scheduleSave();
    return removed;
  }

  getSetting(key, fallback) {
    return Object.prototype.hasOwnProperty.call(this.data.settings, key)
      ? this.data.settings[key]
      : fallback;
  }

  setSetting(key, value) {
    this.data.settings[key] = value;
    this.scheduleSave();
  }

  scheduleSave() {
    this.dirty = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), this.saveDelay);
    if (typeof this.saveTimer.unref === 'function') this.saveTimer.unref();
  }

  /** Немедленно записывает изменения на диск (синхронно). */
  flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty) return true;

    const json = JSON.stringify(this.data, null, 2);
    const dir = path.dirname(this.filePath);
    const tmp = `${this.filePath}.tmp`;
    try {
      fs.mkdirSync(dir, { recursive: true });
      // Прошлая удачная версия становится резервной копией.
      if (fs.existsSync(this.filePath)) {
        try {
          fs.copyFileSync(this.filePath, this.backupPath);
        } catch {
          /* резервная копия — не критично */
        }
      }
      fs.writeFileSync(tmp, json, 'utf8');
      try {
        fs.renameSync(tmp, this.filePath);
      } catch {
        // Windows иногда держит файл (антивирус, индексатор) — пишем напрямую.
        fs.writeFileSync(this.filePath, json, 'utf8');
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* пустяк */
        }
      }
      this.dirty = false;
      return true;
    } catch (err) {
      console.error('Не удалось сохранить заметки:', err);
      return false;
    }
  }
}

module.exports = {
  NotesStore,
  normalizeNote,
  COLORS,
  DEFAULT_COLOR,
  FONT_MIN,
  FONT_MAX,
  FONT_DEFAULT,
  OPACITY_MIN,
};
