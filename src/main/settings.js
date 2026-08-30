'use strict';
/**
 * 设置存储模块
 *
 * - 持久化位置：<userData>/settings.json（Electron userData 目录）
 * - 仅保存与本应用相关的配置，绝不保存 cookie / token / 密码等凭据
 *   （登录凭据由 Chromium 会话自行持久化在 userData 下的 Cookie 文件中）
 * - 支持开发期配置文件 dev.config.json（已被 .gitignore 排除，严禁提交，
 *   防止内网地址等个人信息进入版本库）。仅在「未打包、且用户尚未配置过」时生效。
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const logger = require('./logger');

/** 默认设置（对外发布时不含任何个人信息，服务器地址为空） */
const DEFAULTS = Object.freeze({
  serverUrl: '',            // 飞牛音乐本地服务器地址，例如 http://<你的NAS内网IP>:5666
  remoteUrl: '',            // FN Connect 远程访问地址，例如 https://<你的FN Connect域名>
  accessMode: 'auto',       // auto=优先本地失败切远程 | local=仅本地 | remote=仅远程
  audioDeviceId: '',        // 音频输出设备 id，'' = 跟随系统默认设备
  ignoreCertErrors: false,  // 是否忽略证书错误（FN Connect 隧道证书异常时按需开启，默认关闭）
  showDesktopLyrics: false, // 桌面歌词开关（可选功能）
  lyricsOpacity: 0.9,       // 桌面歌词窗口不透明度 0.3~1
  musicPath: '/music',      // 音乐入口路径：地址路径为空时自动追加（置空则不加）
});

/**
 * 启动早期（app ready 之前）读取已配置的服务器来源列表。
 *
 * 用途：飞牛音乐网页通常运行在纯 HTTP 的内网地址上，Chromium 视其为
 * 「非安全上下文」，页面内 navigator.mediaDevices 不可用（音频设备枚举失败）。
 * 主进程在启动早期将这些来源加入 Chromium 的
 * 'unsafely-treat-insecure-origin-as-secure' 开关，仅对用户自己配置的
 * http 地址生效，使其获得安全上下文能力（设备枚举 / setSinkId 等）。
 *
 * 注意：本函数不得依赖任何 Electron 运行时状态（仅使用 app 的基础路径 API）。
 */
function readConfiguredOriginsPreReady() {
  const origins = new Set();
  const candidates = [];
  // 1) 开发期配置（dev.config.json，git 忽略）
  try {
    if (!app.isPackaged && process.env.FNMUSIC_NO_DEV_CONFIG !== '1') {
      const dev = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'dev.config.json'), 'utf8'));
      candidates.push(dev.serverUrl, dev.remoteUrl);
    }
  } catch { /* 忽略 */ }
  // 2) 用户已保存的设置（userData/settings.json）
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8'));
    candidates.push(raw.serverUrl, raw.remoteUrl);
  } catch { /* 忽略 */ }
  for (const u of candidates) {
    try {
      const url = new URL(String(u));
      if (url.protocol === 'http:' && url.hostname) origins.add(url.origin);
    } catch { /* 忽略非法地址 */ }
  }
  return [...origins];
}

/** 可持久化的键集合（防止写入未知字段） */
const KEYS = Object.keys(DEFAULTS);

/** 类型收窄：只接受合法的字符串/布尔值 */
function sanitize(key, value) {
  const def = DEFAULTS[key];
  if (typeof def === 'boolean') return typeof value === 'boolean' ? value : def;
  if (typeof def === 'string') return typeof value === 'string' ? value : def;
  if (typeof def === 'number') return typeof value === 'number' && Number.isFinite(value) ? value : def;
  return def;
}

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

/** 开发期配置：读取项目根目录 dev.config.json（被 git 忽略，不进入版本库） */
function readDevConfig() {
  try {
    if (process.env.FNMUSIC_NO_DEV_CONFIG === '1') return null; // 测试/CI 环境跳过
    if (app.isPackaged) return null; // 打包后不再读取项目目录
    const p = path.join(app.getAppPath(), 'dev.config.json');
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    // 仅接受字符串字段，防止注入
    return {
      serverUrl: typeof raw.serverUrl === 'string' ? raw.serverUrl.trim() : '',
      remoteUrl: typeof raw.remoteUrl === 'string' ? raw.remoteUrl.trim() : '',
    };
  } catch (e) {
    logger.warn('readDevConfig 失败（忽略）:', e.message);
    return null;
  }
}

let state = { ...DEFAULTS };

/** 加载设置（合并默认值，容错损坏文件） */
function load() {
  state = { ...DEFAULTS };
  try {
    const p = settingsFile();
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      for (const k of KEYS) {
        if (k in raw) state[k] = sanitize(k, raw[k]);
      }
    } else {
      // 从未保存过：若存在开发配置（本地个人地址），作为初始值，方便开发与测试
      const dev = readDevConfig();
      if (dev) {
        if (dev.serverUrl) state.serverUrl = dev.serverUrl;
        if (dev.remoteUrl) state.remoteUrl = dev.remoteUrl;
      }
    }
  } catch (e) {
    logger.warn('读取设置失败，使用默认值:', e.message);
  }
  return state;
}

/** 保存设置（部分更新；仅接受白名单键） */
function update(patch) {
  for (const k of Object.keys(patch || {})) {
    if (KEYS.includes(k)) state[k] = sanitize(k, patch[k]);
  }
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    logger.error('保存设置失败:', e.message);
  }
  return getAll();
}

/** 返回当前设置的浅拷贝（对外只读） */
function getAll() {
  return { ...state };
}

module.exports = { load, update, getAll, readConfiguredOriginsPreReady, DEFAULTS };