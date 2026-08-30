'use strict';
/**
 * 壳页面（工具栏 / 欢迎页 / 设置页）的 preload 桥
 * 通过 contextBridge 向页面暴露最小化、白名单化的 API：
 * - 页面拿不到 Node / Electron 原生能力（contextIsolation + sandbox）；
 * - 只允许调用下方显式声明的方法，且所有参数在主进程再次校验。
 */
const { contextBridge, ipcRenderer } = require('electron');

/** 暴露给页面的 API（只读方法集合） */
const api = {
  /* ---- 设置 ---- */
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),

  /* ---- 服务器 ---- */
  testServer: (url) => ipcRenderer.invoke('server:test', url),

  /* ---- 音频设备 ---- */
  listAudioDevices: () => ipcRenderer.invoke('audio:list'),
  setAudioDevice: (deviceId) => ipcRenderer.invoke('audio:set', { deviceId }),

  /* ---- 导航 ---- */
  navigate: (action) => ipcRenderer.invoke('nav:action', action),

  /* ---- 桌面歌词 ---- */
  setLyricsEnabled: (enabled) => ipcRenderer.invoke('lyrics:set-enabled', { enabled }),
  setLyricsOpacity: (value) => ipcRenderer.invoke('lyrics:set-opacity', { value }),
  setLyricsInteractive: (interactive) => ipcRenderer.invoke('lyrics:set-interactive', { interactive }),

  /* ---- 数据清理 ---- */
  clearData: () => ipcRenderer.invoke('data:clear'),

  /* ---- 关于 / 诊断 ---- */
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  diagnoseAudio: () => ipcRenderer.invoke('app:diagnose-audio'),
  openLogDir: () => ipcRenderer.invoke('app:open-log-dir'),

  /* ---- 窗口 ---- */
  openSettings: (welcome) => ipcRenderer.send('settings:open', Boolean(welcome)),
  closeSettings: () => ipcRenderer.send('settings:close'),

  /* ---- 订阅主进程推送 ---- */
  onStatus: (callback) => {
    ipcRenderer.on('toolbar:status', (_event, data) => callback(data));
    ipcRenderer.send('shell:ready'); // 通知主进程：壳页面已就绪，请求当前状态
  },
};

contextBridge.exposeInMainWorld('fnmusic', api);