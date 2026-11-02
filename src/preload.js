'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** Единственный мост между окнами и главным процессом. */
contextBridge.exposeInMainWorld('zametki', {
  listNotes: () => ipcRenderer.invoke('notes:list'),
  getNote: (id) => ipcRenderer.invoke('note:get', id),
  createNote: () => ipcRenderer.invoke('note:create'),
  updateNote: (id, patch) => ipcRenderer.send('note:update', id, patch),
  openNote: (id) => ipcRenderer.invoke('note:open', id),
  closeNote: (id) => ipcRenderer.invoke('note:close', id),
  deleteNote: (id) => ipcRenderer.invoke('note:delete', id),
  setPinned: (id, pinned) => ipcRenderer.invoke('note:setPinned', id, pinned),
  setColor: (id, color) => ipcRenderer.invoke('note:setColor', id, color),
  setOpacity: (id, opacity) => ipcRenderer.invoke('note:setOpacity', id, opacity),
  setFontSize: (id, size) => ipcRenderer.invoke('note:setFontSize', id, size),

  setWindowSize: (width, height) => ipcRenderer.send('window:setSize', width, height),
  minimizeWindow: () => ipcRenderer.send('window:minimize'),

  showList: () => ipcRenderer.invoke('app:showList'),
  showAll: () => ipcRenderer.invoke('app:showAll'),
  hideAll: () => ipcRenderer.invoke('app:hideAll'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setOpenAtLogin: (value) => ipcRenderer.invoke('settings:setOpenAtLogin', value),

  onNotesChanged: (callback) => {
    const listener = (_event, notes) => callback(notes);
    ipcRenderer.on('notes:changed', listener);
    return () => ipcRenderer.removeListener('notes:changed', listener);
  },
  onNoteMeta: (callback) => {
    const listener = (_event, meta) => callback(meta);
    ipcRenderer.on('note:meta', listener);
    return () => ipcRenderer.removeListener('note:meta', listener);
  },
});
