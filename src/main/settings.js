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
const { app, safeStorage } = require('electron');
const logger = require('./logger');

/** 默认设置（对外发布时不含任何个人信息，服务器地址为空） */
const DEFAULTS = Object.freeze({
  serverUrl: '',            // 飞牛音乐本地服务器地址，例如 http://<你的NAS内网IP>:5666
  remoteUrl: '',            // FN Connect 远程访问地址，例如 https://<你的FN Connect域名>
  accessMode: 'auto',       // auto=优先本地失败切远程 | local=仅本地 | remote=仅远程
  audioDeviceId: '',        // 音频输出设备 id，'' = 跟随系统默认设备
  ignoreCertErrors: false,  // 是否忽略证书错误（FN Connect 隧道证书异常时按需开启，默认关闭）
  musicPath: '/music',      // 音乐入口路径：地址路径为空时自动追加（置空则不加）
  minimizeToTray: true,    // 关闭主窗口时最小化到系统托盘（后台继续播放）
  volume: 1,                // 客户端音量（0~1，作用于网页播放器输出）
  hardwareAcceleration: true,  // 硬件加速（需重启生效；关闭可解决部分显卡/远程桌面黑屏）
  hardwareAccelUserSet: false, // 用户是否显式设置过硬件加速（自动降级不再干预）
  // 登录凭据（自动登录用，v0.1.11）：
  // - loginUsername：明文用户名（非高敏感）；
  // - loginPasswordEnc：密码经 safeStorage（Windows DPAPI）加密后的密文——
  //   settings.json 中**不保存明文密码**；
  // - loginPassword 仅为 IPC 传入的临时载体，不在 DEFAULTS 中、不落盘。
  loginUsername: '',
  loginPasswordEnc: '',
});

/**
 * 启动早期（app ready 之前）读取的预启动配置。
 * 返回 { origins: string[], hardwareAcceleration: boolean }
 *
 * - origins：已配置的 http 服务器来源，供 'unsafely-treat-insecure-origin-as-secure'
 *   开关使用（纯 HTTP 内网地址在 Chromium 中属非安全上下文，mediaDevices 不可用）；
 * - hardwareAcceleration：用户是否启用硬件加速（false 时主进程需在 Chromium 初始化前
 *   调用 app.disableHardwareAcceleration()，否则运行期无法切换）。
 *
 * 注意：本函数不得依赖任何 Electron 运行时状态（仅使用 app 的基础路径 API）。
 */
function readPreReadyConfig() {
  const origins = new Set();
  const candidates = [];
  let settingsFileExists = false;
  let rawSettings = null;
  // 1) 开发期配置（dev.config.json，git 忽略）
  try {
    if (!app.isPackaged && process.env.FNMUSIC_NO_DEV_CONFIG !== '1') {
      const dev = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'dev.config.json'), 'utf8'));
      candidates.push(dev.serverUrl, dev.remoteUrl);
    }
  } catch { /* 忽略 */ }
  // 2) 用户已保存的设置（userData/settings.json，单次读盘复用）
  try {
    const p = path.join(app.getPath('userData'), 'settings.json');
    settingsFileExists = fs.existsSync(p);
    rawSettings = JSON.parse(fs.readFileSync(p, 'utf8'));
    candidates.push(rawSettings.serverUrl, rawSettings.remoteUrl);
  } catch { /* 忽略 */ }
  for (const u of candidates) {
    try {
      const url = new URL(String(u));
      if (url.protocol === 'http:' && url.hostname) origins.add(url.origin);
    } catch { /* 忽略非法地址 */ }
  }
  // 硬件加速偏好（审查轮 E1 升级兼容）：
  // - 全新安装（无 settings.json）：默认开启（用户要求）；
  // - 已存在设置但未含该键（从旧版升级，旧版为软件渲染）：延续关闭，避免黑屏回归；
  // - 显式配置过：按配置。
  let hardwareAcceleration = true;
  if (settingsFileExists) {
    hardwareAcceleration = rawSettings && typeof rawSettings.hardwareAcceleration === 'boolean'
      ? rawSettings.hardwareAcceleration
      : false; // 旧版升级：延续软件渲染
  }
  return { origins: [...origins], hardwareAcceleration };
}

/** 兼容旧调用（仅返回来源列表） */
function readConfiguredOriginsPreReady() {
  return readPreReadyConfig().origins;
}

/** 可持久化的键集合（防止写入未知字段；loginPasswordEnc 为加密密文，可落盘） */
const KEYS = Object.keys(DEFAULTS);

/** 类型收窄：只接受合法的字符串/布尔值 */
function sanitize(key, value) {
  const def = DEFAULTS[key];
  if (typeof def === 'boolean') return typeof value === 'boolean' ? value : def;
  if (typeof def === 'string') return typeof value === 'string' ? value : def;
  if (typeof def === 'number') return typeof value === 'number' && Number.isFinite(value) ? value : def;
  return def;
}

/** 密码加密（safeStorage/DPAPI；不可用时降级 base64 混淆——仍非明文落盘） */
function encryptPassword(plain) {
  if (!plain) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return 'enc:' + safeStorage.encryptString(String(plain)).toString('base64');
    }
  } catch { /* 降级 */ }
  return 'b64:' + Buffer.from(String(plain), 'utf8').toString('base64');
}

/** 密码解密（与 encryptPassword 对应） */
function decryptPassword(stored) {
  if (!stored) return '';
  try {
    if (stored.startsWith('enc:')) {
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
      }
      return ''; // 加密不可用则无法解密（跨机器/环境），视为未设置
    }
    if (stored.startsWith('b64:')) {
      return Buffer.from(stored.slice(4), 'base64').toString('utf8');
    }
  } catch { /* 解密失败视为未设置 */ }
  return '';
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

/** 保存设置（部分更新；仅接受白名单键；loginPassword 为明文临时载体——
 * 落盘前加密为 loginPasswordEnc，settings.json 不保存明文密码）
 * 审查轮 11 A P3：账号/密码长度上限（防超大值写盘） */
function update(patch) {
  const p = patch || {};
  // 登录密码特殊处理：明文 → 加密后存入 loginPasswordEnc（上限 512 字符）
  if ('loginPassword' in p) {
    const plain = typeof p.loginPassword === 'string' ? p.loginPassword.slice(0, 512) : '';
    state.loginPasswordEnc = encryptPassword(plain);
  }
  for (const k of Object.keys(p)) {
    if (KEYS.includes(k) && k !== 'loginPasswordEnc') {
      let v = p[k];
      if (k === 'loginUsername' && typeof v === 'string') v = v.slice(0, 128); // 账号上限
      state[k] = sanitize(k, v);
    }
  }
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    logger.error('保存设置失败:', e.message);
  }
  return getAll();
}

/** 返回当前设置的浅拷贝（对外只读；密码密文不暴露给渲染层） */
function getAll() {
  const out = { ...state };
  delete out.loginPasswordEnc; // 密文仅主进程内部使用
  // loginPasswordSet 反映「可解密」而非仅「密文存在」——safeStorage 不可用
  // 或跨机器（DPAPI 密钥不匹配）时解密失败应视为未设置（审查轮 11 A P2）
  out.loginPasswordSet = Boolean(decryptPassword(state.loginPasswordEnc));
  return out;
}

/** 主进程内部：获取明文密码（自动登录注入用，不经过 IPC 渲染层） */
function getLoginPassword() {
  return decryptPassword(state.loginPasswordEnc);
}

module.exports = { load, update, getAll, getLoginPassword, readConfiguredOriginsPreReady, readPreReadyConfig, DEFAULTS };