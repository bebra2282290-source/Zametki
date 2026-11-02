'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { NotesStore } = require('../src/main/store');

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zametki-'));
  return path.join(dir, 'notes.json');
}

test('первый запуск: пустое хранилище и флаг isFirstRun', () => {
  const store = new NotesStore(tempFile()).load();
  assert.equal(store.isFirstRun, true);
  assert.deepEqual(store.list(), []);
});

test('заметка сохраняется на диск и читается обратно', () => {
  const file = tempFile();
  const store = new NotesStore(file).load();
  const note = store.create({ title: 'Покупки', body: 'молоко\nхлеб', color: 'sage' });
  store.update(note.id, {
    pinned: true,
    opacity: 0.8,
    fontSize: 18,
    bounds: { x: 10, y: 20, width: 300, height: 320 },
  });
  assert.equal(store.flush(), true);

  const again = new NotesStore(file).load();
  assert.equal(again.isFirstRun, false);
  const [loaded] = again.list();
  assert.equal(loaded.title, 'Покупки');
  assert.equal(loaded.body, 'молоко\nхлеб');
  assert.equal(loaded.color, 'sage');
  assert.equal(loaded.pinned, true);
  assert.equal(loaded.opacity, 0.8);
  assert.equal(loaded.fontSize, 18);
  assert.deepEqual(loaded.bounds, { x: 10, y: 20, width: 300, height: 320 });
});

test('update отбрасывает неизвестные поля и неверные значения', () => {
  const store = new NotesStore(tempFile()).load();
  const note = store.create();
  store.update(note.id, {
    id: 'hack',
    color: 'neon',
    opacity: 0.1,
    fontSize: 999,
    pinned: 'yes',
    createdAt: 1,
  });
  const after = store.get(note.id);
  assert.equal(after.id, note.id);
  assert.equal(after.color, 'cream');
  assert.equal(after.opacity, 0.4);
  assert.equal(after.fontSize, 32);
  assert.equal(after.pinned, false);
  assert.equal(after.createdAt, note.createdAt);
});

test('перемещение окна не меняет дату изменения, а текст — меняет', async () => {
  const store = new NotesStore(tempFile()).load();
  const note = store.create({ body: 'a' });
  await new Promise((r) => setTimeout(r, 5));
  store.update(note.id, { bounds: { x: 1, y: 2, width: 300, height: 300 } });
  assert.equal(store.get(note.id).updatedAt, note.updatedAt);
  await new Promise((r) => setTimeout(r, 5));
  const result = store.update(note.id, { body: 'b' });
  assert.equal(result.contentChanged, true);
  assert.ok(store.get(note.id).updatedAt > note.updatedAt);
});

test('список отсортирован: свежие сверху', async () => {
  const store = new NotesStore(tempFile()).load();
  const a = store.create({ title: 'A' });
  await new Promise((r) => setTimeout(r, 5));
  store.create({ title: 'B' });
  await new Promise((r) => setTimeout(r, 5));
  store.update(a.id, { body: 'обновили' });
  assert.deepEqual(
    store.list().map((n) => n.title),
    ['A', 'B'],
  );
});

test('удаление', () => {
  const store = new NotesStore(tempFile()).load();
  const note = store.create();
  assert.equal(store.remove(note.id), true);
  assert.equal(store.remove(note.id), false);
  assert.equal(store.get(note.id), null);
});

test('повреждённый файл: восстановление из резервной копии', () => {
  const file = tempFile();
  const store = new NotesStore(file).load();
  store.create({ title: 'Важное' });
  store.flush();
  // Вторая запись делает предыдущую версию резервной копией.
  store.create({ title: 'Ещё одно' });
  store.flush();

  fs.writeFileSync(file, '{ это не json', 'utf8');

  const restored = new NotesStore(file).load();
  assert.equal(restored.isFirstRun, false);
  assert.deepEqual(
    restored.list().map((n) => n.title),
    ['Важное'],
  );
  const leftovers = fs.readdirSync(path.dirname(file));
  assert.ok(leftovers.some((name) => name.startsWith('notes.json.corrupt-')));
});

test('настройки сохраняются', () => {
  const file = tempFile();
  const store = new NotesStore(file).load();
  store.setSetting('trayHintShown', true);
  store.flush();
  const again = new NotesStore(file).load();
  assert.equal(again.getSetting('trayHintShown', false), true);
  assert.equal(again.getSetting('missing', 'x'), 'x');
});
