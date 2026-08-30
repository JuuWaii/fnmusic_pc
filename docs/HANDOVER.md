# FN Music PC 项目交接文档（HANDOVER）

> 生成时间：2026-08-30（v0.1.6 完成后）
> 用途：将本项目全部上下文、经验与当前状态迁移到新会话/新对话，新会话应首先阅读本文件与 README.md / REVIEW.md / docs/ARCHITECTURE.md。

---

## 1. 项目一句话

**fnmusic_pc**：飞牛音乐（fnOS Music）网页的 Electron PC 客户端——网页嵌套播放、登录态保持、FN Connect 远程访问、音频输出设备与音量调节、系统托盘后台运行。

- 工作目录：`D:\ai\DeepSeek Harness\fnmusic_pc`
- 飞牛服务（用户内网）：`http://<内网IP>:5666`（真实地址见 gitignore 的 dev.config.json），**音乐实际入口 = 门户根地址 + /music**
- 用户机器：Windows 11（build 26200）；另有第二台电脑用于安装版测试（该机 GPU 渲染异常会黑屏）

## 2. 原始需求（10 条，全部落地）

| # | 需求 | 实现要点 |
|---|------|----------|
| 1 | 登录信息持久化免重复登录 | persist:fnmusic-guest 分区 + 固定 userData + cookie flush + 旧数据迁移 |
| 2 | 支持 fn-connect 外网访问 | remoteUrl 配置 + auto 模式（本地优先，失败/12s 超时切远程）+ 忽略证书选项 |
| 3 | 默认网址作欢迎页配置项 | welcome.html 欢迎配置页 + 设置窗口可改；自动追加 /music（musicPath 可配） |
| 4 | 可选音频输出设备 | 设置页 + 独立音频面板（audio-panel），setSinkId 双通道（元素 + AudioContext） |
| 5 | 不修改网页前端 | 纯运行时注入（隔离世界 preload + 主世界脚本），零文件改动 |
| 6 | 桌面歌词（可选） | **已按用户授权移除（v0.1.6）**——多次尝试无法稳定获取歌词 |
| 7 | git 版本控制 | 仓库历史干净（曾重建为单提交），20 个提交 |
| 8 | 多轮审查 | 7 轮审查记录于 REVIEW.md；**用户要求每轮修复后至少三轮独立审查再汇报** |
| 9 | 去除个人信息 | scripts/check-privacy.js（git index 解析扫描）46 文件 0 违规 |
| 10 | 注释与开源合规 | 全文件头注释；THIRD_PARTY_NOTICES.md（Electron/electron-builder/Listen1/YesPlayMusic/MusicBox，MIT） |

## 3. 技术架构

### 3.1 结构
- **壳窗口**：本地页面（toolbar 工具栏 / welcome 欢迎页 / settings 设置 / audio-panel 音频面板），sandbox+contextIsolation+CSP
- **guest 视图**：WebContentsView 承载飞牛网页，独立持久分区 `persist:fnmusic-guest`（登录态）
- **双注入**：
  - `guest-preload.js`（隔离世界，仅在主 frame 运行）：媒体元素 setSinkId 记账（WeakMap）、音量、消息桥
  - `guest-mainworld.js`（主世界，executeJavaScript 注入全部 frame）：AudioContext 代理（构造期 sinkId + master gain 音量 + suspend/resume 设备切换）、诊断
- **主进程模块**：main（入口/单实例/硬件加速/登录态）/ window-manager（窗口/视图/看门狗/注入）/ ipc（全部通道，发送者校验）/ settings / server-url（校验+解析+/music 追加）/ audio-devices（枚举+广播）/ security（权限按来源+证书透传）/ tray / logger（轮转 1MB×5）

### 3.2 关键机制
- **音频设备**：页面为纯 WebAudio（无 audio 元素）→ 构造期 sinkId 选项 + 运行中 suspend→setSinkId→resume（Chromium 限制）+ epoch 串行化；iframe 由主进程对所有 frame 广播 `__fnmusicSetSinkNow`
- **音量**：覆盖 AudioContext.destination getter 返回 master GainNode（disconnect 拦截重连）；媒体元素仅显式指令时设置（不覆盖页面控件）
- **硬件加速**：默认开启（设置/欢迎页可关，重启生效）；升级兼容（旧设置无键 → 延续软件渲染）；黑屏自愈（ready-to-show 10s 超时 + 未显式配置 → 自动软件渲染 + 弹窗重启）；CLI 逃生口 `--disable-gpu` / `--hardware-acceleration`
- **登录态**：userData 固定 `%APPDATA%\FNMusicPC`（所有形态）；旧路径 `fnmusic-pc` 自动迁移（settings.json + Partitions/）；60s cookie flush + 退出双 flush；启动日志与诊断输出 Cookie 文件状态/cookieCount/localStorage 占用
- **安全上下文**：`unsafely-treat-insecure-origin-as-secure` 标记已配置 http 来源（否则 mediaDevices 不可用）
- **托盘**：X 关闭最小化到托盘（可关）、菜单（显示/隐藏/设置/退出）、单实例恢复窗口

## 4. 版本历史（git 46 提交）

- **v0.1.0** 初始：网页嵌套/登录态/cookie 持久化/欢迎页/设备/歌词框架/托盘前身
- **v0.1.1** 黑屏修复：禁用硬件加速 + ready-to-show 兜底
- **v0.1.2** 渲染诊断：生命周期日志 + 自检（黑屏定位）
- **v0.1.3** iframe 广播/构造期 sinkId/异常兜底/日志脱敏轮转/托盘图标/诊断聚合
- **v0.1.4** 音频面板 + 音量系统 + 歌词捕获改进（XHR P0 回归修复）
- **v0.1.5** 硬件加速可选项 + cookie flush + 诊断容错 + DOM 歌词兜底
- **v0.1.6** 移除桌面歌词 + 登录态修复（固定 userData/迁移）+ 黑屏自愈闭环 + 卸载清理
- **v0.1.7** **黑屏回归修复**：welcome 模式壳页面从不加载（shellMode 初始短路）→ 初始改 null 强制加载；三轮审查处置（回归测试真覆盖/诊断作用域修复/自愈误判加固）
- **v0.1.8/v0.1.9** **三问题修复**：FN Connect 带个人路径地址不追加 /music → 进入 NAS 桌面（applyMusicPath 改为仅 musicPath 结尾不重复追加）；登录态诊断路径修正（Electron 33 Cookie 在 Network/）；设置窗口/音频面板 ready-to-show 超时兜底 + 欢迎页/设置页硬件加速 touched 标记（防保存任意设置切回硬件加速）；三轮审查处置（隐私路径段检测/边界测试）
- **v0.1.10** **设备枚举 iframe 修复 + 登录态诊断**：listDevices 遍历全部 frame（门户音乐应用渲染在跨域 iframe，主 frame mediaDevices 不可用）；诊断新增 cookie 按域分组/session 标志/localStorage 按 frame；三轮审查处置（null 守卫/多 frame 测试/日志脱敏）
- **v0.1.11** **自动登录**：登录态根因=门户 music-token 为 session cookie（重启即丢）→ 设置页保存账号密码（safeStorage/DPAPI 加密落盘，无明文）→ 登录页自动填写提交（iframe 全注入 + origin 过滤 + React/Vue 兼容 + SPA MutationObserver）；两轮审查处置（welcome 选择器/清空语义/origin 过滤/可解密判定/长度上限）
- **v0.1.12** **自动登录真机联调**：CDP 实测发现 /music/login 有「使用 NAS 登录」与「登录」双按钮，旧正则误点 NAS → 优先 type=submit + 精确文本锚定排除 NAS/忘记；SPA 轮询 + MutationObserver 覆盖动态表单；真机端到端验证填写+提交成功
- **v0.1.13** **欢迎页自动登录配置**：欢迎页新增账号密码输入区（虚线卡片样式），保存语义与设置页一致（账号变化才提交/密码非空才提交/清空账号清密码）；复用既有凭据加密链路
- **v0.1.14** **FN Connect 自动登录修复**：远程地址 302 到内网（origin 变化）导致注入被过滤 → 主 frame 信任导航链 + 页面侧 origin 校验（已配置 origins ∪ FN Connect 官方代理域）；文案改「飞牛音乐账号（非 NAS 账号）」；历史隐私清理（filter-branch 重写敏感 commit message）
- **v0.1.15** **自动登录失效修复**：v0.1.14 页面侧 origin 校验正则写于模板字符串，反斜杠经字符串解析丢失 → 生成脚本 SyntaxError 未执行 → 双反斜杠转义修复；CDP 端到端验证填写+提交成功
- **v0.1.16/v0.1.17**（当前）**自动登录提速+循环检测+仅 remoteUrl 修复**：150ms 循环检测（dom-ready 注入/MutationObserver 全监听/去节流）检测登录页加载完成即填表一次；页面侧 origin 校验仅对子 frame 严格（主 frame 信任导航链——FN Connect 仅配置 remoteUrl 时 302 到内网可自动填写）

## 5. 关键经验教训（新会话必读，避免重复踩坑）

### 5.1 环境与工具链（本机 DSH 沙箱环境）
1. **npm 缓存必须放工作区**（`.npmrc` 已配 `cache=.npm-cache`），否则 EPERM；
2. **curl 的 schannel TLS 被沙箱拦截**，Electron 二进制需 `node scripts/electron-download.js`（node fetch 可用；GitHub 慢/超时 → npmmirror 镜像自动回退）；electron@33.4.11（v44 在该环境 Chromium 初始化崩溃，33 亦崩——**本沙箱内 Electron GUI 无法启动**，只能无头测试 + 用户真机验证）；
3. **electron-builder 派生子进程（npm/app-builder/7za/makensis）触发沙箱 EPERM**：打包命令必须带 `sandbox_permissions: "danger-full-access"`（先被拒后升级，需用户批准）+ 环境变量 `ELECTRON_BUILDER_CACHE=`.builder-cache`、`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`；
4. **输出目录被锁定（EBUSY）**：win-unpacked 的 app.asar 被占用（用户正在运行/杀软扫描）→ 先 `Stop-Process FNMusicPC`，仍锁则用 `--config.directories.output=dist-new` 换目录构建后复制产物；
5. **git filter-branch 在沙箱不可用**（sh 信号管道被禁）→ 清理历史用「重建单提交仓库」（`rm -rf .git && git init`）；
6. 构建产物 exe 文件名含版本号，旧版本清理后避免用户误用。

### 5.2 产品技术经验
1. **纯 WebAudio 播放器**：诊断发现飞牛播放器无 <audio> 元素（elements:0），一切以 AudioContext 为准；隔离世界 preload 无法影响主世界（contextIsolation），必须主世界注入；
2. **preload 默认只在主 frame 运行**（nodeIntegrationInSubFrames=false）→ iframe 场景必须主进程对 framesInSubtree 广播；
3. **Chromium 限制**：运行中 AudioContext 直接 setSinkId 返回成功但输出不变（需 suspend/resume）；AudioContext 构造期 sinkId 选项可避免竞态；
4. **黑屏**：GPU 合成失败（特定驱动/远程桌面）→ 禁用硬件加速/软件渲染；ready-to-show 可能不触发（需超时兜底强制显示）；**黑屏 ≠ 一定是 GPU**——v0.1.7 教训：壳页面从未加载（switchShellMode 短路）同样表现为黑屏且软件渲染下依旧，判定依据是日志有无「壳页面开始加载/加载完成」；
5. **登录态丢失**：便携版 userData 随 exe 移动 → 必须固定 userData 路径；cookie 异步写盘 → 周期 flush；
6. **第三方面板数据捕获（歌词）不可靠**：fetch/XHR/WS/DOM 四通道均无法稳定获取飞牛歌词 → 按用户授权移除，避免过度投入；
7. **日志是排查黑屏/登录态的关键**：生命周期日志、自检、诊断接口（设置页按钮）缺一不可；logger 失败必须显式报错（早期静默失败导致无法定位）；
8. **每轮修复必须三轮审查**（用户流程要求）：A 功能正确性 / B 整体回归与需求 / C 安全隐私；审查常发现 P0 级回归（如 XHR 钩子引用已删常量）。

### 5.3 隐私红线（用户硬性要求）
- 仓库不得出现真实 IP、凭据、FN Connect 域名、cookie/token——check-privacy 扫描 + 历史重建保障；
- 真实地址只在 gitignore 的 `dev.config.json` 与 `新建 文本文档.txt`（用户任务笔记，勿动勿提交）；
- 日志/诊断对 URL 脱敏（sanitizeUrl：剥 query/hash、token 打码）、userData 路径 %USERPROFILE% 化。

## 6. 当前状态（v0.1.17，工作区干净）

- git：46 提交，HEAD = v0.1.17 修复提交（+版本号待提交）；`git status` 干净
- 测试：`npm test` → scripts/test-headless.js **60/60 通过**
- 隐私：`npm run check:privacy` → 42 文件 0 违规（含 FN Connect 个人路径段检测）
- 产物：`dist\FNMusicPC Setup 0.1.17.exe`（安装版）、`dist\FNMusicPC 0.1.17.exe`（便携版）
- 依赖：electron ^33.4.11、electron-builder ^26.15.3、node_modules 已装（含手动下载的 electron 二进制）

## 7. 待办与验证清单（用户真机）

1. **v0.1.17 验证（重点）**：仅配置 remoteUrl（FN Connect）时登录页应自动填写提交；本地模式同验；
2. **已知问题（后续版本修复）**：FN Connect 远程连接时音频设备枚举失败（mediaDevices API 不可用），内网地址正常——疑似远程跳转链页面非安全上下文，待下版本修复；
2. **登录态验证**：登录一次 → 托盘退出 → 重开免登录；看日志 Cookie 文件与诊断 `cookieCount/localStorage`；
3. **音频面板**：工具栏 🔊 → 设备即选即生效 + 音量联动（已确认正常，回归验证）；
4. **欢迎页测试**：移走 dev.config.json 后启动应显示欢迎页（地址预填来自 dev.config.json）——v0.1.7 已修复该路径；
5. **GitHub 发布（已完成 v0.1.17）**：https://github.com/JuuWaii/fnmusic_pc（源码）+ https://github.com/JuuWaii/fnmusic_pc/releases/tag/v0.1.17（Release：安装版+便携版）；发布前已完成三轮审查（git 历史隐私重写：作者匿名化/敏感 blob 清零）+ 关于区占位替换 + README 歌词残留清理；后续版本更新后推送需重新走隐私检查；
6. 遗留：dist/win-unpacked 与 dist-new 曾因 Defender 占用无法清理（EBUSY），如占用已释放可删除。

## 8. 常用命令速查

```powershell
cd D:\ai\DeepSeek Harness\fnmusic_pc
npm test                 # 无头测试（60 项）
npm run check:privacy    # 隐私合规检查
npm start                # 源码启动（真机；控制台可见日志）
npm run smoke            # 冒烟测试（真机；自动加载自检退出）
npm run dist             # 打包（真机直接可用；本沙箱需升级权限+镜像环境变量）
# 打包环境变量：$env:ELECTRON_BUILDER_CACHE=".builder-cache"; $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
# 输出目录被占用时：npm run dist -- --config.directories.output=dist-new
```

## 9. 用户偏好与协作约定

- 中文沟通；结构化、表格化汇报；每轮修复后 **≥3 轮独立审查** 再汇报；
- 改动前先确认、功能移除需用户授权（如桌面歌词）；GitHub 发布必须等授权；
- 真机验证依赖用户执行（本沙箱无法启动 GUI）；验证产物路径要写清楚（dist\ 下的 exe）；
- 注意清理旧版本产物避免用户误用；升级打包前先 `Stop-Process FNMusicPC` 防 EBUSY。
