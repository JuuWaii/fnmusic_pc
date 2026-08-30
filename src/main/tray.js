'use strict';
/**
 * 系统托盘（后台运行支持）
 *
 * 功能：
 * - 托盘图标：左键单击 显示/隐藏 主窗口；
 * - 托盘菜单：显示/隐藏、设置、桌面歌词开关、退出；
 * - 主窗口关闭按钮（X）在「关闭时最小化到托盘」开启时，隐藏到托盘继续后台播放；
 * - 托盘「退出」才真正结束进程（并同步销毁歌词窗口，避免僵尸进程）。
 */
const { Tray, Menu, nativeImage, app } = require('electron');
const path = require('path');
const logger = require('./logger');
const settings = require('./settings');
const lyrics = require('./lyrics');

let tray = null;
let getMainWindow = null;

/** 托盘图标路径（开发/打包均可用：构建资源打进 asar，nativeImage 支持从 asar 读取） */
function iconPath() {
  return path.join(app.getAppPath(), 'build', 'icon.png');
}

/** 创建托盘 */
function createTray(mainWindowGetter) {
  if (tray) return tray;
  getMainWindow = mainWindowGetter;

  let icon = nativeImage.createFromPath(iconPath());
  if (icon.isEmpty()) {
    // 兜底：纯色小图标（极端情况下 asar 内资源读取失败）
    icon = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAFElEQVR42mNk+M9Qz0BkYBxVg6kDAKJZBBpF8H6QAAAAAElFTkSuQmCC'
    );
  }
  // 托盘推荐 16x16
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('FN Music PC · 飞牛音乐');
  rebuildMenu();

  // 左键单击：显示/隐藏主窗口
  tray.on('click', () => toggleMainWindow());
  tray.on('double-click', () => showMainWindow());

  logger.info('系统托盘已就绪');
  return tray;
}

/** 显示主窗口（托盘尚未创建时也能通过 window-manager 兜底恢复） */
function showMainWindow() {
  let w = getMainWindow && getMainWindow();
  if (!w) {
    try { w = require('./window-manager').getMainWindow(); } catch { /* 忽略 */ }
  }
  if (!w || w.isDestroyed()) return;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
}

/** 显示/隐藏切换 */
function toggleMainWindow() {
  const w = getMainWindow && getMainWindow();
  if (!w || w.isDestroyed()) return;
  if (w.isVisible()) {
    w.hide();
  } else {
    showMainWindow();
  }
}

/** 重建托盘菜单（歌词开关状态随设置变化） */
function rebuildMenu() {
  if (!tray) return;
  const lyricsOn = Boolean(settings.getAll().showDesktopLyrics);
  const menu = Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => showMainWindow(),
    },
    {
      label: '隐藏主窗口',
      click: () => {
        const w = getMainWindow && getMainWindow();
        if (w && !w.isDestroyed()) w.hide();
      },
    },
    { type: 'separator' },
    {
      label: '设置…',
      click: () => {
        if (global.__fnmusicOpenSettings) global.__fnmusicOpenSettings();
      },
    },
    {
      label: lyricsOn ? '关闭桌面歌词' : '开启桌面歌词',
      click: () => {
        const on = !lyricsOn;
        settings.update({ showDesktopLyrics: on });
        lyrics.setEnabled(on);
        rebuildMenu();
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        // 真正的退出：标记后允许主窗口 close 生效
        global.__fnmusicQuit = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

module.exports = { createTray, rebuildMenu, showMainWindow, toggleMainWindow };