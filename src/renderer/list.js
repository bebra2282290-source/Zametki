'use strict';

(async () => {
  const api = window.zametki;
  const $ = (sel) => document.querySelector(sel);

  const grid = $('#grid');
  const empty = $('#empty');
  const nothing = $('#nothing');
  const search = $('#search');
  const count = $('#count');
  const template = $('#tpl-card');
  const confirmBox = $('#confirm');

  /** id → элемент карточки, чтобы не перерисовывать всё при каждом нажатии клавиши. */
  const cards = new Map();
  let notes = [];
  let firstRender = true;
  let pendingDeleteId = null;

  // ---------------- Даты по-русски ----------------

  const timeFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const dayFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });
  const yearFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });

  function plural(n, one, few, many) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
  }

  function formatDate(ts) {
    const now = new Date();
    const date = new Date(ts);
    const minutes = Math.floor((now - date) / 60000);
    if (minutes < 1) return 'только что';
    if (minutes < 60) return `${minutes} ${plural(minutes, 'минуту', 'минуты', 'минут')} назад`;
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (ts >= startOfToday) return `сегодня, ${timeFmt.format(date)}`;
    if (ts >= startOfToday - 86400000) return `вчера, ${timeFmt.format(date)}`;
    if (date.getFullYear() === now.getFullYear()) return dayFmt.format(date).replace('.', '');
    return yearFmt.format(date).replace('.', '');
  }

  // ---------------- Отрисовка ----------------

  function splitNote(note) {
    const title = note.title.trim();
    if (title) return { title, preview: note.body.trim() };
    // Без заголовка: первая строка текста становится заголовком.
    const lines = note.body.trim().split('\n');
    return { title: lines[0] || '', preview: lines.slice(1).join('\n').trim() };
  }

  function matches(note, q) {
    if (!q) return true;
    return `${note.title}\n${note.body}`.toLocaleLowerCase('ru').includes(q);
  }

  function createCard(note) {
    const el = template.content.firstElementChild.cloneNode(true);
    el.dataset.id = note.id;
    if (!firstRender) el.classList.add('is-new');
    el.addEventListener('animationend', () => el.classList.remove('is-new'), { once: true });
    return el;
  }

  function fillCard(el, note) {
    const { title, preview } = splitNote(note);
    el.dataset.color = note.color;
    el.classList.toggle('is-pinned', note.pinned);
    el.classList.toggle('is-closed', !note.open);

    const titleEl = el.querySelector('.card-title');
    titleEl.textContent = title || 'Без названия';
    titleEl.classList.toggle('is-untitled', !title);

    el.querySelector('.card-body').textContent = preview.slice(0, 400);
    el.querySelector('.card-date').textContent = formatDate(note.updatedAt);

    const pinBtn = el.querySelector('.card-pin');
    pinBtn.title = note.pinned ? 'Открепить' : 'Закрепить поверх окон';
    el.setAttribute('aria-label', title || 'Без названия');
  }

  function render() {
    const q = search.value.trim().toLocaleLowerCase('ru');
    const visible = notes.filter((n) => matches(n, q));

    count.textContent = notes.length ? String(notes.length) : '';
    empty.hidden = notes.length !== 0;
    nothing.hidden = notes.length === 0 || visible.length !== 0;

    const keep = new Set(visible.map((n) => n.id));
    for (const [id, el] of cards) {
      if (!keep.has(id)) {
        el.remove();
        cards.delete(id);
      }
    }

    visible.forEach((note, index) => {
      let el = cards.get(note.id);
      if (!el) {
        el = createCard(note);
        cards.set(note.id, el);
      }
      fillCard(el, note);
      if (grid.children[index] !== el) grid.insertBefore(el, grid.children[index] || null);
    });

    firstRender = false;
  }

  // ---------------- Действия ----------------

  grid.addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    const id = card.dataset.id;
    const note = notes.find((n) => n.id === id);
    if (!note) return;

    if (e.target.closest('.card-pin')) {
      api.setPinned(id, !note.pinned);
    } else if (e.target.closest('.card-delete')) {
      askDelete(note);
    } else {
      api.openNote(id);
    }
  });

  grid.addEventListener('keydown', (e) => {
    const card = e.target.closest('.card');
    if (!card || e.target !== card) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      api.openNote(card.dataset.id);
    } else if (e.key === 'Delete') {
      const note = notes.find((n) => n.id === card.dataset.id);
      if (note) askDelete(note);
    }
  });

  function askDelete(note) {
    pendingDeleteId = note.id;
    const { title } = splitNote(note);
    $('#confirm-text').textContent = title
      ? `«${title.slice(0, 40)}» исчезнет насовсем.`
      : 'Вернуть её уже не получится.';
    confirmBox.hidden = false;
    $('#confirm-cancel').focus();
  }

  function closeConfirm() {
    confirmBox.hidden = true;
    pendingDeleteId = null;
  }

  $('#confirm-cancel').addEventListener('click', closeConfirm);
  $('#confirm-ok').addEventListener('click', () => {
    if (pendingDeleteId) api.deleteNote(pendingDeleteId);
    closeConfirm();
  });
  confirmBox.addEventListener('mousedown', (e) => {
    if (e.target === confirmBox) closeConfirm();
  });

  $('#btn-new').addEventListener('click', () => api.createNote());
  $('#btn-new-empty').addEventListener('click', () => api.createNote());
  $('#btn-show-all').addEventListener('click', () => api.showAll());
  $('#btn-hide-all').addEventListener('click', () => api.hideAll());

  search.addEventListener('input', render);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!confirmBox.hidden) closeConfirm();
      else if (search.value) {
        search.value = '';
        render();
      }
      return;
    }
    if (e.ctrlKey && !e.altKey && e.code === 'KeyN') {
      e.preventDefault();
      api.createNote();
    } else if (e.ctrlKey && !e.altKey && e.code === 'KeyF') {
      e.preventDefault();
      search.focus();
      search.select();
    }
  });

  // ---------------- Автозапуск ----------------

  const settings = await api.getSettings();
  const loginToggle = $('#login-toggle');
  const loginInput = $('#open-at-login');
  if (settings.canOpenAtLogin) {
    loginToggle.hidden = false;
    loginInput.checked = settings.openAtLogin;
    loginInput.addEventListener('change', async () => {
      loginInput.checked = await api.setOpenAtLogin(loginInput.checked);
    });
  }

  // ---------------- Данные ----------------

  api.onNotesChanged((next) => {
    notes = next;
    render();
  });
  notes = await api.listNotes();
  render();

  // «5 минут назад» должно оставаться правдой.
  setInterval(() => {
    for (const note of notes) {
      const el = cards.get(note.id);
      if (el) el.querySelector('.card-date').textContent = formatDate(note.updatedAt);
    }
  }, 30000);
})();
