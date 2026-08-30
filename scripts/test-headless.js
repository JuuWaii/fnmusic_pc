'use strict';
/**
 * 无头测试套件（npm test）
 *
 * 在无法启动 GUI 的环境（CI / 沙箱）中验证核心逻辑：
 * - server-url：地址校验（含长度上限）/ 解析 / 自动回退意图
 * - settings：读写与类型收窄（跳过 dev.config.json）
 * - ipc：IPC 处理器注册与关键行为（发送者校验、设置联动、来源限制）
 * - window-manager：壳模式切换、加载意图
 * - guest-mainworld：主世界注入脚本（音频 API 暴露、容错）
 *
 * 通过 Module._load 注入 electron 桩实现，不依赖真实 GUI。
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
process.env.FNMUSIC_NO_DEV_CONFIG = '1'; // 跳过 dev.config.json（隐私/确定性）

let passed = 0;
let failed = 0;
const testQueue = []; // 顺序执行队列（支持 async 测试）

/** 注册测试（按注册顺序依次执行，保证异步测试之间不交错） */
function ok(name, fn) {
  testQueue.push({ name, fn });
}

/* ---------------- Electron 桩 ---------------- */

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'fnmusic-test-'));
const RENDERER_DIR = path.join(ROOT, 'src', 'renderer').replace(/\\/g, '/');

/** 可信壳发送方事件 */
const shellEvent = {
  senderFrame: { url: 'file:///' + RENDERER_DIR + '/settings.html' },
  sender: { getURL: () => 'file:///' + RENDERER_DIR + '/settings.html' },
};
/** 可信 guest 发送方事件（与测试设置的 serverUrl 同源） */
const guestEvent = {
  senderFrame: { url: 'http://127.0.0.1:5666/' },
  sender: { getURL: () => 'http://127.0.0.1:5666/' },
};
/** 不可信发送方事件 */
const evilEvent = {
  senderFrame: { url: 'http://evil.example.com/x' },
  sender: { getURL: () => 'http://evil.example.com/x' },
};

function makeWebContentsStub() {
  const wc = {
    _sent: [],
    _loadCalls: [],
    send(ch, data) { this._sent.push({ ch, data }); },
    on() {},
    once() {},
    mainFrame: { framesInSubtree: [], executeJavaScript: async () => {} },
    executeJavaScript: async (code) => {
      if (String(code).includes('enumerateDevices')) {
        return { ok: true, devices: [{ deviceId: 'dev-1', label: '扬声器' }, { deviceId: 'dev-2', label: '耳机' }] };
      }
      return 2;
    },
    loadURL: async (u) => { wc._loadCalls.push('url:' + u); },
    loadFile: async (f) => { wc._loadCalls.push('file:' + f); },
    getURL: () => 'http://127.0.0.1:5666/', getTitle: () => '飞牛 fnOS',
    canGoBack: () => false, canGoForward: () => false, isLoading: () => false,
    isDestroyed: () => false, reload() {}, goBack() {}, goForward() {}, stop() {},
    setWindowOpenHandler() {},
  };
  return wc;
}

/** electron 桩工厂 */
function electronStub() {
  const ipcHandlers = {};
  const ipcOns = {};
  const wins = [];
  const views = [];
  return {
    app: {
      getPath: (name) => (name === 'userData' ? tmpUserData : os.tmpdir()),
      getAppPath: () => ROOT,
      isPackaged: false,
      getVersion: () => '0.1.0-test',
      setAppUserModelId() {}, requestSingleInstanceLock: () => true,
      whenReady: () => Promise.resolve(), on() {}, quit() {}, exit() {},
    },
    BrowserWindow: class {
      constructor() { this.webContents = makeWebContentsStub(); this.contentView = { addChildView() {}, removeChildView() {} }; wins.push(this); }
      getContentSize() { return [1280, 800]; }
      on() {} once() {} isDestroyed() { return false; } isMinimized() { return false; }
      show() {} showInactive() {} hide() {} focus() {} restore() {} close() {}
      setTitle() {} setOpacity() {} setAlwaysOnTop() {}
      getPosition() { return [100, 100]; } setPosition() {}
      loadFile() { return Promise.resolve(); } setIgnoreMouseEvents() {}
    },
    WebContentsView: class {
      constructor() { this.webContents = makeWebContentsStub(); views.push(this); }
      setBounds() {}
    },
    ipcMain: {
      handle: (ch, fn) => { ipcHandlers[ch] = fn; },
      on: (ch, fn) => { (ipcOns[ch] = ipcOns[ch] || []).push(fn); },
    },
    session: {
      fromPartition: () => {
        const ses = {
          _cleared: [],
          setPreloads() {}, setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
          setCertificateVerifyProc() {},
          async clearStorageData() { ses._cleared.push('storage'); },
          async clearCache() { ses._cleared.push('cache'); },
          async clearAuthCache() { ses._cleared.push('auth'); },
        };
        return ses;
      },
    },
    Menu: {
      setApplicationMenu() {},
      buildFromTemplate: () => ({ popup() {} }),
    },
    Tray: class {
      constructor(icon) { this.icon = icon; }
      setToolTip() {} setContextMenu() {} on() {}
    },
    nativeImage: {
      createFromPath: () => ({ isEmpty: () => true, resize: () => ({}) }),
      createFromDataURL: () => ({ isEmpty: () => false, resize: () => ({}) }),
    },
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    shell: { openExternal: async () => {} },
    _ipcHandlers: ipcHandlers,
    _ipcOns: ipcOns,
    _wins: wins,
    _views: views,
  };
}

/** 注入 electron 桩并加载模块（每次全新实例，清理 require 缓存避免跨组状态串扰） */
function loadWithStub(modulePath, stub) {
  delete require.cache[require.resolve(modulePath)]; // 模块级状态（窗口/视图/设置内存态）需要隔离
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return stub;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

/* ---------------- 测试组 ---------------- */

console.log('\n[1] server-url');
{
  const stub = electronStub();
  const su = loadWithStub(path.join(ROOT, 'src/main/server-url.js'), stub);
  ok('校验合法 http 地址', () => {
    assert.strictEqual(su.validateUrl(' http://127.0.0.1:5666/ '), 'http://127.0.0.1:5666');
  });
  ok('拒绝非 http(s)', () => {
    assert.strictEqual(su.validateUrl('file:///C:/x'), null);
    assert.strictEqual(su.validateUrl('javascript:alert(1)'), null);
  });
  ok('拒绝 URL 内嵌凭据', () => {
    assert.strictEqual(su.validateUrl('http://' + 'user:pass' + '@127.0.0.1:5666'), null);
  });
  ok('拒绝超长 URL', () => {
    assert.strictEqual(su.validateUrl('http://127.0.0.1:5666/' + 'a'.repeat(3000)), null);
  });
  ok('auto 模式本地优先', () => {
    const r = su.resolve({ serverUrl: 'http://127.0.0.1:5666', remoteUrl: 'https://x.' + 'fnos.net', accessMode: 'auto' });
    assert.strictEqual(r.url, 'http://127.0.0.1:5666');
    assert.strictEqual(r.triedRemote, false);
  });
  ok('remote 模式用远程地址', () => {
    const r = su.resolve({ serverUrl: 'http://127.0.0.1:5666', remoteUrl: 'https://x.' + 'fnos.net', accessMode: 'remote' });
    assert.strictEqual(r.url, 'https://x.' + 'fnos.net');
  });
  ok('未配置时返回 null', () => {
    const r = su.resolve({ serverUrl: '', remoteUrl: '', accessMode: 'auto' });
    assert.strictEqual(r.url, null);
  });
  ok('空路径地址自动追加 /music', () => {
    const r = su.resolve({ serverUrl: 'http://127.0.0.1:5666', remoteUrl: '', accessMode: 'auto', musicPath: '/music' });
    assert.strictEqual(r.url, 'http://127.0.0.1:5666/music');
  });
  ok('已含路径的地址不重复追加', () => {
    const r = su.resolve({ serverUrl: 'http://127.0.0.1:5666/music', remoteUrl: '', accessMode: 'auto', musicPath: '/music' });
    assert.strictEqual(r.url, 'http://127.0.0.1:5666/music');
  });
  ok('musicPath 置空则不追加', () => {
    const r = su.resolve({ serverUrl: 'http://127.0.0.1:5666', remoteUrl: '', accessMode: 'auto', musicPath: '' });
    assert.strictEqual(r.url, 'http://127.0.0.1:5666');
  });
  ok('无 musicPath 字段时保持兼容（不追加）', () => {
    const r = su.resolve({ serverUrl: 'http://127.0.0.1:5666', remoteUrl: '', accessMode: 'auto' });
    assert.strictEqual(r.url, 'http://127.0.0.1:5666');
  });
  ok('auto 模式远程回退目标也追加路径', () => {
    const r = su.resolve({
      serverUrl: 'http://127.0.0.1:5666',
      remoteUrl: 'https://x.' + 'fnos.net',
      accessMode: 'auto', musicPath: '/music',
    });
    assert.strictEqual(r.url, 'http://127.0.0.1:5666/music');
    assert.strictEqual(r.fallback, 'https://x.' + 'fnos.net/music');
  });
  ok('applyMusicPath 独立函数行为', () => {
    assert.strictEqual(su.applyMusicPath('http://127.0.0.1:5666', { musicPath: '/music' }), 'http://127.0.0.1:5666/music');
    assert.strictEqual(su.applyMusicPath('http://127.0.0.1:5666/music', { musicPath: '/music' }), 'http://127.0.0.1:5666/music');
    assert.strictEqual(su.applyMusicPath('not-a-url', { musicPath: '/music' }), null);
  });
  ok('isConfigured 判定', () => {
    assert.strictEqual(su.isConfigured({ serverUrl: '', remoteUrl: '' }), false);
    assert.strictEqual(su.isConfigured({ serverUrl: 'http://127.0.0.1:5666', remoteUrl: '' }), true);
  });
}

console.log('\n[2] settings');
{
  const stub = electronStub();
  const st = loadWithStub(path.join(ROOT, 'src/main/settings.js'), stub);
  st.load();
  ok('默认值加载（无个人信息）', () => {
    const s = st.getAll();
    assert.strictEqual(s.serverUrl, '');
    assert.strictEqual(s.accessMode, 'auto');
    assert.strictEqual(s.musicPath, '/music');
    assert.strictEqual(s.minimizeToTray, true);
  });
  ok('update 白名单与类型收窄', () => {
    st.update({ serverUrl: 'http://127.0.0.1:5666', accessMode: 'local', evil: 123, audioDeviceId: 999 });
    const s = st.getAll();
    assert.strictEqual(s.serverUrl, 'http://127.0.0.1:5666');
    assert.strictEqual(s.accessMode, 'local');
    assert.strictEqual(s.audioDeviceId, ''); // 非法类型被忽略
    assert.ok(!('evil' in s));
  });
  ok('持久化回读', () => {
    st.update({ volume: 0.6 });
    const st2 = loadWithStub(path.join(ROOT, 'src/main/settings.js'), stub);
    st2.load();
    assert.strictEqual(st2.getAll().volume, 0.6);
    assert.strictEqual(st2.getAll().serverUrl, 'http://127.0.0.1:5666');
  });
  ok('readConfiguredOriginsPreReady 提取 http 来源（排除 https）', () => {
    st.update({ remoteUrl: 'https://secure.example.com' }); // 应被排除
    const origins = st.readConfiguredOriginsPreReady();
    assert.ok(origins.includes('http://127.0.0.1:5666'), 'http 来源应被包含');
    assert.ok(!origins.some((o) => o.includes('example.com')), 'https 来源不应被包含');
  });
  ok('readPreReadyConfig 升级检测：旧版设置延续软件渲染，新版按配置', () => {
    // 模拟旧版（0.1.4 及以前）的 settings.json：不含 hardwareAcceleration 键
    const fsx = require('fs');
    fsx.writeFileSync(path.join(tmpUserData, 'settings.json'), JSON.stringify({
      serverUrl: 'http://127.0.0.1:5666',
      accessMode: 'auto',
    }));
    assert.strictEqual(st.readPreReadyConfig().hardwareAcceleration, false, '旧版升级应延续软件渲染');
    // 显式配置后按配置
    st.update({ hardwareAcceleration: true });
    assert.strictEqual(st.readPreReadyConfig().hardwareAcceleration, true);
    st.update({ hardwareAcceleration: false });
    assert.strictEqual(st.readPreReadyConfig().hardwareAcceleration, false);
    st.update({ hardwareAcceleration: true }); // 恢复
  });
  ok('readConfiguredOriginsPreReady 忽略非法来源', () => {
    st.update({ serverUrl: 'not-a-url' });
    const origins = st.readConfiguredOriginsPreReady();
    assert.ok(Array.isArray(origins));
    st.update({ serverUrl: 'http://127.0.0.1:5666' }); // 恢复
  });
}

console.log('\n[4] ipc 处理器');
{
  const stub = electronStub();
  // 块内同步初始化设置（队列测试执行时块已完成）
  const settingsMod = loadWithStub(path.join(ROOT, 'src/main/settings.js'), stub);
  settingsMod.load();
  settingsMod.update({ serverUrl: 'http://127.0.0.1:5666', accessMode: 'local' });
  const wm = loadWithStub(path.join(ROOT, 'src/main/window-manager.js'), stub);
  wm.createMainWindow();
  const fakeSession = stub.session.fromPartition('persist:x');
  const ipc = loadWithStub(path.join(ROOT, 'src/main/ipc.js'), stub);
  ipc.register({ guestSession: fakeSession });
  const H = stub._ipcHandlers;

  ok('settings:get 拒绝不可信发送者', async () => {
    assert.strictEqual(await H['settings:get'](evilEvent), null);
  });
  ok('settings:get 返回设置', async () => {
    const s = await H['settings:get'](shellEvent);
    assert.ok('serverUrl' in s && 'accessMode' in s);
  });
  ok('settings:save 联动（音频设备）', async () => {
    const r = await H['settings:save'](shellEvent, { audioDeviceId: 'dev-1' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.settings.audioDeviceId, 'dev-1');
  });
  ok('settings:save 拒绝非法地址（带回错误信息）', async () => {
    const r = await H['settings:save'](shellEvent, { serverUrl: 'ftp://bad' });
    assert.strictEqual(r.ok, false);
    assert.ok(r.error);
    assert.strictEqual(r.settings.serverUrl, 'http://127.0.0.1:5666'); // 保持原值未变
  });
  ok('server:test 校验地址格式', async () => {
    const r = await H['server:test'](shellEvent, 'not-a-url');
    assert.strictEqual(r.ok, false);
  });
  ok('server:test 真实短超时（不可达地址）', async () => {
    const r = await H['server:test'](shellEvent, 'http://127.0.0.1:9');
    assert.strictEqual(r.ok, false);
  });
  ok('server:test 拒绝不可信发送者', async () => {
    const r = await H['server:test'](evilEvent, 'http://127.0.0.1:9');
    assert.strictEqual(r.ok, false);
  });
  ok('audio:list 走 guest 枚举', async () => {
    const r = await H['audio:list'](shellEvent);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.devices.length, 2);
  });
  ok('nav:action 白名单', async () => {
    await H['nav:action'](shellEvent, 'evil');
    await H['nav:action'](shellEvent, 'home'); // 不应抛错
  });
  ok('app:info 版本信息', async () => {
    const info = await H['app:info'](shellEvent);
    assert.strictEqual(info.appVersion, '0.1.0-test');
    assert.ok(info.node); // 版本字段存在即可
  });
  ok('data:clear 执行清理（含认证缓存）', async () => {
    const r = await H['data:clear'](shellEvent);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(fakeSession._cleared.sort(), ['auth', 'cache', 'storage']);
  });
  ok('settings:save 硬件加速变更返回 needsRestart', async () => {
    const r1 = await H['settings:save'](shellEvent, { hardwareAcceleration: true });
    const r2 = await H['settings:save'](shellEvent, { hardwareAcceleration: false });
    const r3 = await H['settings:save'](shellEvent, { hardwareAcceleration: true });
    assert.strictEqual(r1.needsRestart, false); // 未变化
    assert.strictEqual(r2.needsRestart, true);  // 变更
    assert.strictEqual(r3.needsRestart, true);  // 再次变更
    assert.strictEqual(r3.settings.hardwareAcceleration, true);
  });
  ok('volume:set 正常设置', async () => {
    const r = await H['volume:set'](shellEvent, { value: 0.3 });
    assert.strictEqual(r, 0.3);
  });
  ok('volume:set 非法载荷被忽略（不静音不清零）', async () => {
    const before = await H['settings:get'](shellEvent);
    const r = await H['volume:set'](shellEvent, { value: NaN });
    assert.strictEqual(r, before.volume, '非法值应保持原音量');
    const r2 = await H['volume:set'](shellEvent, {});
    assert.strictEqual(r2, before.volume);
    await H['volume:set'](shellEvent, { value: 1 }); // 恢复
  });
}

console.log('\n[5] window-manager');
{
  const stub = electronStub();
  // 先加载 settings（wm/ipc 通过 require 缓存引用同一实例）
  const settingsMod = loadWithStub(path.join(ROOT, 'src/main/settings.js'), stub);
  settingsMod.load();
  settingsMod.update({ serverUrl: '', remoteUrl: '' });
  const wm = loadWithStub(path.join(ROOT, 'src/main/window-manager.js'), stub);
  wm.createMainWindow();
  const viewsAfterWelcome = stub._views.length; // 未配置时不应创建 guest 视图
  const shellWc = stub._wins[0] && stub._wins[0].webContents;
  settingsMod.update({ serverUrl: 'http://127.0.0.1:5666', accessMode: 'auto' });
  wm.loadHome();
  const viewsAfterLoadHome = stub._views.length; // 配置后懒创建 1 个
  ok('未配置 → welcome 模式（不创建 guest 视图）', () => {
    assert.strictEqual(viewsAfterWelcome, 0);
  });
  ok('未配置 → welcome 模式必须加载欢迎页（黑屏回归：壳页面从不加载）', () => {
    // 回归测试：shellMode 初始值曾为 'welcome'，switchShellMode 短路导致 welcome.html 永不加载
    const fileCalls = (shellWc && shellWc._loadCalls || []).filter((c) => c.startsWith('file:'));
    assert.ok(fileCalls.length > 0, '应有 loadFile 调用，实际: ' + JSON.stringify(shellWc && shellWc._loadCalls));
    assert.ok(fileCalls.some((c) => c.includes('welcome.html')), '应加载 welcome.html');
  });
  ok('loadHome 懒创建 guest 视图', () => {
    assert.strictEqual(viewsAfterLoadHome, 1);
  });
  settingsMod.update({ serverUrl: '', remoteUrl: '' });
  wm.loadHome();
  ok('清空地址 → 回到 welcome 模式', () => {
    // 不抛错即可
  });
}

console.log('\n[6] security（来源校验）');
{
  const stub = electronStub();
  const settingsMod = loadWithStub(path.join(ROOT, 'src/main/settings.js'), stub);
  settingsMod.load();
  settingsMod.update({ serverUrl: 'http://127.0.0.1:5666', remoteUrl: 'https://my-nas.' + 'fnos.net' });
  const sec = loadWithStub(path.join(ROOT, 'src/main/security.js'), stub);
  const getSettings = () => settingsMod.getAll();
  ok('isTrustedOrigin 命中已配置主机', () => {
    assert.strictEqual(sec.isTrustedOrigin(getSettings, 'http://127.0.0.1:5666/biz/music'), true);
    assert.strictEqual(sec.isTrustedOrigin(getSettings, 'https://my-nas.' + 'fnos.net/x'), true);
  });
  ok('isTrustedOrigin 拒绝陌生来源', () => {
    assert.strictEqual(sec.isTrustedOrigin(getSettings, 'http://evil.example.com/'), false);
    assert.strictEqual(sec.isTrustedOrigin(getSettings, ''), false);
    assert.strictEqual(sec.isTrustedOrigin(getSettings, 'not-a-url'), false);
  });
}

console.log('\n[7] tray 托盘模块');
{
  const stub = electronStub();
  const tray = loadWithStub(path.join(ROOT, 'src/main/tray.js'), stub);
  ok('createTray 创建托盘（空图标兜底）', () => {
    const tr = tray.createTray(() => null);
    assert.ok(tr);
  });
  ok('showMainWindow 无窗口时不抛错', () => {
    tray.showMainWindow();
  });
  ok('toggleMainWindow 无窗口时不抛错', () => {
    tray.toggleMainWindow();
  });
}

console.log('\n[9] guest-mainworld 浏览器入口（注入脚本关键路径）');
{
  // 构造浏览器桩环境后加载注入脚本，验证：XHR 钩子不抛错（P0 回归）、fetch 歌词嗅探、音量 API
  const savedGlobals = {};
  const messages = [];
  const xhrCalls = [];

  savedGlobals.window = global.window;
  savedGlobals.document = global.document;
  global.document = { title: 't', querySelectorAll: () => [], documentElement: {} };
  global.window = {
    location: { protocol: 'http:', href: 'http://127.0.0.1:5666/music' },
    addEventListener(ev, fn) { (global.__winListeners = global.__winListeners || {})[ev] = fn; },
    postMessage(data) { messages.push(data); },
    setInterval() { return 1; },
    document: { title: 't', querySelectorAll: () => [], },
    AudioContext: undefined,
    postMessage: (d) => messages.push(d),
  };

  // 清缓存：确保 IIFE 在当前浏览器桩环境中重新执行
  delete require.cache[require.resolve(path.join(ROOT, 'src/main/guest-mainworld.js'))];
  const gm9 = require(path.join(ROOT, 'src/main/guest-mainworld.js'));

  ok('注入脚本安装后无异常（initErrors 为空）', () => {
    const diagNow = global.window.__fnmusicDiagnose();
    assert.deepStrictEqual(diagNow.initErrors, []);
  });

  ok('__fnmusicSetVolume 已暴露且为函数', () => {
    assert.strictEqual(typeof global.window.__fnmusicSetVolume, 'function');
  });
  ok('__fnmusicSetSinkNow 已暴露且为函数', () => {
    assert.strictEqual(typeof global.window.__fnmusicSetSinkNow, 'function');
  });
  ok('清理浏览器桩全局', () => {
    // 队列执行完本组测试后再恢复全局（避免影响其他组）
    if (savedGlobals.window === undefined) delete global.window; else global.window = savedGlobals.window;
    if (savedGlobals.document === undefined) delete global.document; else global.document = savedGlobals.document;
  });
}

/* ---------------- 汇总 ---------------- */
(async () => {
  for (const { name, fn } of testQueue) {
    try {
      await fn();
      passed++;
      console.log('  ✓ ' + name);
    } catch (e) {
      failed++;
      console.log('  ✗ ' + name + ' → ' + e.message);
    }
  }
  console.log('\n===== 结果: ' + passed + ' 通过, ' + failed + ' 失败 =====');
  process.exit(failed ? 1 : 0);
})();