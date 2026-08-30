'use strict';
/**
 * 桌面歌词窗口的 preload 桥（与主进程双向通信的最小 API）
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fnmusicLyrics', {
  /** 订阅歌词更新（主进程每 250ms 推送一次） */
  onUpdate: (callback) => {
    ipcRenderer.on('lyrics:update', (_event, data) => callback(data));
  },
  /** 拖动窗口 */
  dragStart: (p) => ipcRenderer.send('lyrics:drag-start', p),
  dragMove: (p) => ipcRenderer.send('lyrics:drag-move', p),
  dragEnd: () => ipcRenderer.send('lyrics:drag-end'),
  /** 关闭歌词 */
  close: () => ipcRenderer.send('lyrics:close'),
  /** 点击穿透切换 */
  toggleInteractive: () => ipcRenderer.send('lyrics:toggle-interactive'),
});
