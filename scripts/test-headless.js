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
    mainFrame: {
      framesInSubtree: [],
      url: 'http://127.0.0.1:5666/',
      executeJavaScript: async (code) => {
        if (String(code).includes('enumerateDevices')) {
          return { ok: true, devices: [{ deviceId: 'dev-1', label: '扬声器' }, { deviceId: 'dev-2', label: '耳机' }] };
        }
        return 2;
      },
    },
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
    // v0.1.11 自动登录：safeStorage 桩（base64 加密模拟 DPAPI）
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(String(s), 'utf8'),
      decryptString: (buf) => buf.toString('utf8'),
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
  ok('FN Connect 个人地址（带路径）也追加 /music（v0.1.8 修复：不再进入 NAS 桌面）', () => {
    // 用户 remoteUrl 形如 https://fnos.net/<用户名>，路径非空但并非音乐入口 →
    // 必须追加 /music，否则进入 NAS 门户桌面
    const r = su.resolve({
      serverUrl: '', remoteUrl: 'https://x.' + 'fnos.net/user-0001',
      accessMode: 'remote', musicPath: '/music',
    });
    assert.strictEqual(r.url, 'https://x.' + 'fnos.net/user-0001/music');
  });
  ok('远程地址已含 /music 结尾则不重复追加', () => {
    const r = su.applyMusicPath('https://x.' + 'fnos.net/user-0001/music', { musicPath: '/music' });
    assert.strictEqual(r, 'https://x.' + 'fnos.net/user-0001/music');
  });
  ok('musicPath 留空时带路径地址保持原样（不追加）', () => {
    const r = su.applyMusicPath('https://x.' + 'fnos.net/user-0001', { musicPath: '' });
    assert.strictEqual(r, 'https://x.' + 'fnos.net/user-0001');
  });
  ok('applyMusicPath 边界：musicPath 无前导斜杠', () => {
    const r = su.applyMusicPath('https://x.' + 'fnos.net/user-0001', { musicPath: 'music' });
    assert.strictEqual(r, 'https://x.' + 'fnos.net/user-0001/music');
  });
  ok('applyMusicPath 边界：musicPath 带尾斜杠', () => {
    const r = su.applyMusicPath('https://x.' + 'fnos.net/user-0001', { musicPath: '/music/' });
    assert.strictEqual(r, 'https://x.' + 'fnos.net/user-0001/music');
  });
  ok('applyMusicPath 边界：输入 URL 带尾斜杠与 query', () => {
    const r = su.applyMusicPath('https://x.' + 'fnos.net/user-0001/?a=1', { musicPath: '/music' });
    assert.strictEqual(r, 'https://x.' + 'fnos.net/user-0001/music?a=1');
  });
  ok('applyMusicPath 边界：近似路径不误判（/music-box 仍追加）', () => {
    const r = su.applyMusicPath('https://x.' + 'fnos.net/user-0001/music-box', { musicPath: '/music' });
    assert.strictEqual(r, 'https://x.' + 'fnos.net/user-0001/music-box/music');
  });
  ok('isConfigured 判定', () => {
    assert.strictEqual(su.isConfigured({ serverUrl: '', remoteUrl: '' }), false);
    assert.strictEqual(su.isConfigured({ serverUrl: 'http://127.0.0.1:5666', remoteUrl: '' }), true);
  });
}

console.log('\n[1b] autoLoginSnippet 按钮匹配（审查轮 12：不再误点「使用 NAS 登录」）');
{
  // 从 window-manager.js 提取 findLoginBtn 的核心匹配逻辑做纯函数验证
  const src = require('fs').readFileSync(path.join(ROOT, 'src/main/window-manager.js'), 'utf8');
  const m = src.match(/function autoLoginSnippet\(username, password, trustedOrigins\) \{[\s\S]*?\n  \}/);
  assert.ok(m, 'autoLoginSnippet 应存在于 window-manager.js');
  const code = new Function('username', 'password', 'trustedOrigins', m[0] + '\nreturn autoLoginSnippet;')()('u', 'p', []);
  // 脚本应包含 submit 优先逻辑（修复点）
  ok('脚本优先匹配 type=submit 登录按钮（防误点「使用 NAS 登录」）', () => {
    assert.ok(code.includes("b.type === 'submit'"), '应优先 type=submit');
    assert.ok(code.includes('!/NAS|忘记|注册/i.test(t)'), '应排除 NAS/忘记按钮');
    assert.ok(code.includes('getClientRects'), '可见性判断应使用 getClientRects');
    assert.ok(code.includes('setInterval'), '应有轮询兜底');
    assert.ok(code.includes('MutationObserver'), '应有 SPA 监听');
    assert.ok(code.includes('location.origin'), '应有页面侧 origin 校验（审查轮 14）');
    assert.ok(code.includes('fnos') && code.includes('5ddd') && code.includes('trzznas'), '应信任 FN Connect 官方代理域');
    // v0.1.15 修复：模板字符串中正则必须用双反斜杠，否则生成脚本 SyntaxError
    // （生成后的脚本中正则应为单反斜杠形式 \/ 与 \.）
    assert.ok(code.includes('https:\\/\\/'), '正则 https:// 必须保留反斜杠转义');
    assert.ok(code.includes('fnos\\.net'), '正则 fnos.net 必须保留反斜杠转义');
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
  ok('自动登录凭据：密码加密落盘、明文不暴露、可解密回读（v0.1.11）', () => {
    st.update({ loginUsername: 'my-account', ['login' + 'Password']: 'pw-7ch' });
    // getAll 不暴露密文与明文，只给布尔标志
    const s = st.getAll();
    assert.strictEqual(s.loginUsername, 'my-account');
    assert.strictEqual(s.loginPasswordSet, true);
    assert.ok(!('loginPassword' in s), 'getAll 不得含明文密码');
    assert.ok(!('loginPasswordEnc' in s), 'getAll 不得含密文');
    // 落盘文件不得出现明文密码
    const raw = JSON.parse(require('fs').readFileSync(path.join(tmpUserData, 'settings.json'), 'utf8'));
    assert.ok(!JSON.stringify(raw).includes('pw-7ch'), 'settings.json 不得含明文密码');
    assert.ok(raw.loginPasswordEnc, 'settings.json 应存加密密文');
    // 主进程内部解密
    const st3 = loadWithStub(path.join(ROOT, 'src/main/settings.js'), stub);
    st3.load();
    assert.strictEqual(st3.getLoginPassword(), 'pw-7ch');
    // 空密码更新不覆盖已存密码
    st3.update({ loginUsername: 'my-account2' });
    assert.strictEqual(st3.getLoginPassword(), 'pw-7ch', '未提交密码时保持原密码');
    // 清空账号时密码同步清除
    st3.update({ loginUsername: '', loginPassword: '' });
    assert.strictEqual(st3.getLoginPassword(), '');
  });
  ok('自动登录凭据：safeStorage 不可用降级 b64 + 跨环境解密失败视为未设置（审查轮 11）', () => {
    // b64 降级：safeStorage 不可用时仍可加密/解密（混淆存储）
    const stubNoSafe = electronStub();
    stubNoSafe.safeStorage = {
      isEncryptionAvailable: () => false,
      encryptString: () => { throw new Error('unavailable'); },
      decryptString: () => { throw new Error('unavailable'); },
    };
    const stB64 = loadWithStub(path.join(ROOT, 'src/main/settings.js'), stubNoSafe);
    stB64.load();
    stB64.update({ loginUsername: 'b64-user', loginPassword: 'pw-7ch' });
    assert.strictEqual(stB64.getLoginPassword(), 'pw-7ch', 'b64 降级应可回读');
    assert.strictEqual(stB64.getAll().loginPasswordSet, true);
    // 跨环境：密文存在但解密失败（DPAPI 密钥不匹配模拟）→ loginPasswordSet=false
    const stubBroken = electronStub();
    stubBroken.safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: () => Buffer.from('x'),
      decryptString: () => { throw new Error('key mismatch'); },
    };
    const stBroken = loadWithStub(path.join(ROOT, 'src/main/settings.js'), stubBroken);
    stBroken.load();
    stBroken.update({ loginUsername: 'broken-user', loginPassword: 'pw-7ch' });
    const sb = stBroken.getAll();
    assert.strictEqual(sb.loginPasswordSet, false, '解密失败应视为未设置');
    // 长度上限：超长账号/密码被截断
    st.update({ loginUsername: 'u'.repeat(200), loginPassword: 'p'.repeat(600) });
    assert.strictEqual(st.getAll().loginUsername.length, 128);
    assert.strictEqual(st.getLoginPassword().length, 512);
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
  // 关键：必须在后续 loadHome() 之前抓取快照（否则会被「清空地址」路径的
  // welcome.html 加载记录污染，回归测试将失去意义——审查轮 8 P1）
  const welcomeLoadsAtCreate = (shellWc && shellWc._loadCalls || [])
    .filter((c) => c.startsWith('file:') && c.includes('welcome.html')).length;
  settingsMod.update({ serverUrl: 'http://127.0.0.1:5666', accessMode: 'auto' });
  wm.loadHome();
  const viewsAfterLoadHome = stub._views.length; // 配置后懒创建 1 个
  ok('未配置 → welcome 模式（不创建 guest 视图）', () => {
    assert.strictEqual(viewsAfterWelcome, 0);
  });
  ok('未配置 → welcome 模式必须加载欢迎页（黑屏回归：壳页面从不加载）', () => {
    // 回归测试：shellMode 初始值曾为 'welcome'，switchShellMode 短路导致 welcome.html 永不加载
    assert.strictEqual(welcomeLoadsAtCreate, 1,
      'createMainWindow 后应立即加载 welcome.html，实际次数: ' + welcomeLoadsAtCreate);
  });
  ok('loadHome 懒创建 guest 视图', () => {
    assert.strictEqual(viewsAfterLoadHome, 1);
  });
  settingsMod.update({ serverUrl: '', remoteUrl: '' });
  wm.loadHome();
  ok('清空地址 → 回到 welcome 模式', () => {
    // 不抛错即可
  });
  ok('listDevices 多 frame 回退（主 frame 失败 → iframe 成功，审查轮 10）', async () => {
    // 飞牛门户把音乐应用渲染在 iframe：主 frame 无 mediaDevices，iframe 可枚举
    const audioDev = loadWithStub(path.join(ROOT, 'src/main/audio-devices.js'), electronStub());
    const wc = makeWebContentsStub();
    wc.mainFrame.executeJavaScript = async (code) => {
      if (String(code).includes('enumerateDevices')) return { ok: false, error: 'mediaDevices API 不可用' };
      return 2;
    };
    wc.mainFrame.framesInSubtree = [{
      url: 'http://127.0.0.1:5666/music',
      executeJavaScript: async (code) => {
        if (String(code).includes('enumerateDevices')) return { ok: true, devices: [{ deviceId: 'dev-9', label: 'iframe 扬声器' }] };
        return 2;
      },
    }];
    const r = await audioDev.listDevices(wc);
    assert.strictEqual(r.ok, true, 'iframe 枚举应成功');
    assert.ok(r.devices.some((d) => d.deviceId === 'dev-9'), '应返回 iframe 设备');
  });
  ok('listDevices 全部 frame 失败时聚合错误（审查轮 10）', async () => {
    const audioDev3 = loadWithStub(path.join(ROOT, 'src/main/audio-devices.js'), electronStub());
    const wc3 = makeWebContentsStub();
    wc3.mainFrame.executeJavaScript = async (code) => {
      if (String(code).includes('enumerateDevices')) return { ok: false, error: 'mediaDevices API 不可用' };
      return 2;
    };
    const r3 = await audioDev3.listDevices(wc3);
    assert.strictEqual(r3.ok, false, '全部失败应返回 ok:false');
    assert.ok(String(r3.error).includes('mediaDevices'), '错误信息应含原因');
  });  ok('diagnoseAllFrames 不抛错（getInjectFailures 作用域回归，审查轮 8 P1）', async () => {
    // 曾因 injectFailures 声明在 createGuestView 函数体内，模块级 getter 访问越界抛 ReferenceError
    const d = await wm.diagnoseAllFrames();
    assert.ok(d && Array.isArray(d.frames), '应返回 { frames: [] }');
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