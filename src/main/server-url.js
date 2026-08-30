'use strict';
/**
 * 服务器地址解析与校验
 *
 * 支持两类地址：
 *  - 本地地址：局域网内飞牛音乐网页入口，如 http://<你的NAS内网IP>:5666
 *  - FN Connect 远程地址：飞牛官方远程访问服务分配的域名
 *    （官方代理域名包括 fnos.net / 5ddd.com / trzznas.com 等，
 *      详见 https://help.fnnas.com/articles/v1/access/how-access ，
 *      实际以用户在飞牛系统「FN Connect」设置页中获取到的访问地址为准）
 *
 * 地址一律以字符串形式保存在用户自己的 settings.json 中（userData 目录），
 * 本仓库代码中不含任何真实内网地址 / 远程域名。
 */
const logger = require('./logger');

/** URL 长度上限（防脏数据/日志膨胀） */
const MAX_URL_LENGTH = 2048;

/** 仅允许 http/https 协议 */
function validateUrl(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(/\/$/, ''); // 去掉末尾斜杠
  if (!s) return null;
  if (s.length > MAX_URL_LENGTH) return null; // 长度上限
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname) return null;
    // 拒绝在 URL 中携带用户名密码（userinfo），避免凭据泄漏
    if (u.username || u.password) return null;
    // 拒绝带 hash（网页应用无需锚点，去掉更安全）
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

/**
 * 按设置给地址追加「音乐入口路径」
 *
 * 背景：飞牛音乐网页的实际入口是「门户根地址 + /music」
 * （例如 http://192.168.x.x:5666/music），用户通常只填写门户根地址
 * （打开后是飞牛 NAS 桌面）。若配置了 musicPath 且地址路径为空，自动追加。
 * - 地址本身已包含路径（如已填 /music）时不追加；
 * - musicPath 置空则完全不追加。
 *
 * @param {string|null} rawUrl 待处理地址
 * @param {{musicPath?:string}} settings
 * @returns {string|null} 处理后的地址
 */
function applyMusicPath(rawUrl, settings) {
  const url = validateUrl(rawUrl);
  if (!url) return null;
  const path = settings && typeof settings.musicPath === 'string' ? settings.musicPath.trim() : '';
  if (!path) return url;
  try {
    const u = new URL(url);
    // 路径为空（'/' 或 ''）才追加
    const base = u.pathname.replace(/\/+$/, '');
    if (base) return url;
    const p = path.startsWith('/') ? path : '/' + path;
    u.pathname = p.replace(/\/+$/, '') || '/';
    return u.toString().replace(/\/$/, '');
  } catch {
    return url;
  }
}

/**
 * 根据访问模式解析出「当前应加载」的地址（含音乐入口路径与远程回退目标）
 * @param {{serverUrl:string, remoteUrl:string, accessMode:string, musicPath?:string}} settings
 * @returns {{url:string|null, mode:string, triedRemote:boolean, fallback:string|null}}
 */
function resolve(settings) {
  const local = validateUrl(settings.serverUrl);
  const remote = validateUrl(settings.remoteUrl);
  const mode = settings.accessMode === 'remote' ? 'remote' : settings.accessMode === 'local' ? 'local' : 'auto';

  let url = null;
  let fallback = null;
  if (mode === 'local') {
    url = local;
  } else if (mode === 'remote') {
    // 仅远程模式：优先远程地址；远程未配置时退回本地
    url = remote || local;
  } else {
    // auto：本地优先（主进程在加载失败时自动尝试远程，见 window-manager.js）
    url = local || remote;
  }

  if (url) url = applyMusicPath(url, settings);

  // 远程回退目标（auto 模式本地优先、且远程地址存在且不同时）
  if (mode === 'auto' && local && remote) {
    const remoteEff = applyMusicPath(remote, settings);
    if (remoteEff !== url) fallback = remoteEff;
  }

  return { url, mode, triedRemote: mode === 'remote', fallback };
}

/** 判断是否已配置任何可用地址（欢迎页/主界面切换用） */
function isConfigured(settings) {
  return Boolean(validateUrl(settings.serverUrl) || validateUrl(settings.remoteUrl));
}

/** 仅用于日志/界面展示的简短主机名（不包含路径） */
function displayHost(url) {
  if (!url) return '未配置';
  try {
    const u = new URL(url);
    return u.host + (u.protocol === 'https:' ? ' (https)' : '');
  } catch {
    return url;
  }
}

/**
 * URL 脱敏（日志/诊断用）：去掉 query 与 hash，并抹掉常见凭据形参，防止
 * token/session 等凭据落盘或被分享（审查轮 C L1）。
 * @param {string} raw
 * @returns {string}
 */
function sanitizeUrl(raw) {
  if (!raw) return '';
  try {
    const u = new URL(raw);
    // 抹掉常见凭据形参（保留其他 query 的业务含义有限，一并清除更安全）
    const clean = u.search
      ? u.search.replace(/([?&](?:token|access_token|session|sid|sign|auth|key|secret)=)[^&]*/gi, '$1***')
      : '';
    u.search = clean;
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

module.exports = { validateUrl, applyMusicPath, resolve, isConfigured, displayHost, sanitizeUrl };