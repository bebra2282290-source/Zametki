'use strict';

(async () => {
  const api = window.zametki;
  const id = new URLSearchParams(location.search).get('id');

  const $ = (sel) => document.querySelector(sel);
  const titleEl = $('#title');
  const bodyEl = $('#body');
  const pinBtn = $('#btn-pin');
  const menuBtn = $('#btn-menu');
  const menu = $('#menu');
  const opacityInput = $('#opacity');
  const opacityValue = $('#opacity-value');
  const fontValue = $('#font-value');
  const confirmBox = $('#confirm');

  const FONT_MIN = 11;
  const FONT_MAX = 32;
  const FONT_DEFAULT = 15;

  const note = await api.getNote(id);
  if (!note) {
    api.closeNote(id);
    return;
  }

  const state = {
    pinned: note.pinned,
    color: note.color,
    opacity: note.opacity,
    fontSize: note.fontSize,
  };

  titleEl.value = note.title;
  bodyEl.value = note.body;
  applyMeta(state);
  updateDocTitle();

  // В новой пустой заметке курсор сразу стоит в тексте — можно печатать.
  if (!note.title && !note.body) requestAnimationFrame(() => bodyEl.focus());

  // ---------------- Текст: сохраняем на каждое изменение ----------------

  function saveText() {
    api.updateNote(id, { title: titleEl.value, body: bodyEl.value });
    updateDocTitle();
  }
  titleEl.addEventListener('input', saveText);
  bodyEl.addEventListener('input', saveText);

  titleEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || (e.key === 'ArrowDown' && !e.shiftKey)) {
      e.preventDefault();
      bodyEl.focus();
      bodyEl.setSelectionRange(0, 0);
    }
  });

  function updateDocTitle() {
    const text = (titleEl.value || bodyEl.value).trim().split('\n')[0];
    document.title = text ? text.slice(0, 60) : 'Заметка';
  }

  // ---------------- Внешний вид ----------------

  function applyMeta(meta) {
    Object.assign(state, meta);
    document.body.dataset.color = state.color;
    document.body.classList.toggle('is-pinned', state.pinned);
    document.body.style.setProperty('--fs', `${state.fontSize}px`);

    pinBtn.classList.toggle('is-active', state.pinned);
    pinBtn.setAttribute('aria-pressed', String(state.pinned));
    const pinLabel = state.pinned ? 'Открепить (Ctrl+P)' : 'Закрепить поверх всех окон (Ctrl+P)';
    pinBtn.title = pinLabel;
    pinBtn.setAttribute('aria-label', pinLabel);

    for (const swatch of document.querySelectorAll('.swatch')) {
      swatch.classList.toggle('is-selected', swatch.dataset.value === state.color);
    }

    const percent = Math.round(state.opacity * 100);
    opacityInput.value = String(percent);
    opacityValue.textContent = `${percent}%`;
    fontValue.textContent = String(state.fontSize);
  }

  api.onNoteMeta((meta) => applyMeta(meta));

  window.addEventListener('blur', () => document.body.classList.add('is-blurred'));
  window.addEventListener('focus', () => document.body.classList.remove('is-blurred'));
  if (!document.hasFocus()) document.body.classList.add('is-blurred');

  // ---------------- Кнопки шапки ----------------

  $('#btn-new').addEventListener('click', () => api.createNote());
  $('#btn-close').addEventListener('click', () => closeNote());
  pinBtn.addEventListener('click', () => togglePin());

  function togglePin() {
    applyMeta({ pinned: !state.pinned });
    api.setPinned(id, state.pinned);
  }

  function closeNote() {
    saveText();
    api.closeNote(id);
  }

  // ---------------- Меню ----------------

  function setMenuOpen(open) {
    menu.hidden = !open;
    menuBtn.setAttribute('aria-expanded', String(open));
    menuBtn.classList.toggle('is-open', open);
  }

  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setMenuOpen(menu.hidden);
  });
  document.addEventListener('mousedown', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !menuBtn.contains(e.target)) setMenuOpen(false);
  });
  window.addEventListener('blur', () => setMenuOpen(false));

  $('#swatches').addEventListener('click', (e) => {
    const swatch = e.target.closest('.swatch');
    if (!swatch) return;
    applyMeta({ color: swatch.dataset.value });
    api.setColor(id, state.color);
  });

  let opacityFrame = 0;
  opacityInput.addEventListener('input', () => {
    const value = Number(opacityInput.value) / 100;
    opacityValue.textContent = `${opacityInput.value}%`;
    state.opacity = value;
    cancelAnimationFrame(opacityFrame);
    opacityFrame = requestAnimationFrame(() => api.setOpacity(id, value));
  });

  function changeFont(delta) {
    const next =
      delta === 0 ? FONT_DEFAULT : Math.min(FONT_MAX, Math.max(FONT_MIN, state.fontSize + delta));
    if (next === state.fontSize) return;
    applyMeta({ fontSize: next });
    api.setFontSize(id, next);
  }
  $('#font-dec').addEventListener('click', () => changeFont(-1));
  $('#font-inc').addEventListener('click', () => changeFont(+1));

  $('#item-list').addEventListener('click', () => {
    setMenuOpen(false);
    api.showList();
  });

  $('#item-delete').addEventListener('click', () => {
    setMenuOpen(false);
    confirmBox.hidden = false;
    $('#confirm-cancel').focus();
  });
  $('#confirm-cancel').addEventListener('click', () => {
    confirmBox.hidden = true;
    bodyEl.focus();
  });
  $('#confirm-ok').addEventListener('click', () => api.deleteNote(id));
  confirmBox.addEventListener('mousedown', (e) => {
    if (e.target === confirmBox) confirmBox.hidden = true;
  });

  // ---------------- Клавиатура и колесо ----------------

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!confirmBox.hidden) confirmBox.hidden = true;
      else if (!menu.hidden) setMenuOpen(false);
      return;
    }
    if (!e.ctrlKey || e.altKey) return;
    const key = e.code;
    if (key === 'KeyN') {
      e.preventDefault();
      api.createNote();
    } else if (key === 'KeyP') {
      e.preventDefault();
      togglePin();
    } else if (key === 'KeyW') {
      e.preventDefault();
      closeNote();
    } else if (key === 'Equal' || key === 'NumpadAdd') {
      e.preventDefault();
      changeFont(+1);
    } else if (key === 'Minus' || key === 'NumpadSubtract') {
      e.preventDefault();
      changeFont(-1);
    } else if (key === 'Digit0' || key === 'Numpad0') {
      e.preventDefault();
      changeFont(0);
    }
  });

  window.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      changeFont(e.deltaY < 0 ? +1 : -1);
    },
    { passive: false },
  );

  // ---------------- Уголок изменения размера ----------------
  // Края окна тянутся и так (это делает Windows), а уголок — удобная
  // видимая «ручка» для тех, кто не попадает в тонкую рамку.

  const grip = $('#grip');
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const start = { x: e.screenX, y: e.screenY, w: window.outerWidth, h: window.outerHeight };
    let frame = 0;
    let last = null;

    const onMove = (ev) => {
      last = { w: start.w + (ev.screenX - start.x), h: start.h + (ev.screenY - start.y) };
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          api.setWindowSize(last.w, last.h);
        });
      }
    };
    const onUp = () => {
      grip.removeEventListener('pointermove', onMove);
      grip.removeEventListener('pointerup', onUp);
      grip.removeEventListener('pointercancel', onUp);
      if (last) api.setWindowSize(last.w, last.h);
    };
    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', onUp);
    grip.addEventListener('pointercancel', onUp);
  });
})();
