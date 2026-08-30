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
 * 根据访问模式解析出「当前应加载」的地址
 * @param {{serverUrl:string, remoteUrl:string, accessMode:string}} settings
 * @returns {{url:string|null, mode:string, triedRemote:boolean}}
 */
function resolve(settings) {
  const local = validateUrl(settings.serverUrl);
  const remote = validateUrl(settings.remoteUrl);
  const mode = settings.accessMode === 'remote' ? 'remote' : settings.accessMode === 'local' ? 'local' : 'auto';

  if (mode === 'local') return { url: local, mode, triedRemote: false };
  if (mode === 'remote') {
    // 仅远程模式：优先远程地址；远程未配置时退回本地
    return { url: remote || local, mode, triedRemote: true };
  }
  // auto：本地优先（主进程在加载失败时自动尝试远程，见 window-manager.js）
  return { url: local || remote, mode, triedRemote: false };
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

module.exports = { validateUrl, resolve, isConfigured, displayHost };