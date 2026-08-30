# 审查记录（REVIEW）

本项目按需求进行多轮独立审查。以下为各轮审查的范围、发现与处置记录。

## 审查轮 1：需求符合度审查

**范围**：对照 10 条需求逐条核查（登录态持久化 / fn-connect / 欢迎页配置 / 音频设备 / 零侵入 / 桌面歌词 / git / 多轮审查 / 个人信息去除 / 注释与开源许可）。

**关键发现与处置**：

| # | 发现 | 严重度 | 处置 |
|---|------|--------|------|
| 1 | auto 模式回退仅覆盖 did-fail-load，无加载超时看门狗 | 中 | 已实现 12s 加载看门狗（window-manager.js） |
| 2 | 渲染进程崩溃后固定重载本地地址 | 中 | 改为重载当前实际地址 |
| 3 | 保存设置无条件整页重载 guest，打断播放 | 高 | 主进程比较解析后地址，仅实际变化才重载 |
| 4 | 已保存的设备/歌词设置在页面重载后不回放 | 高 | did-finish-load 回放设置（replaySettingsToGuest） |
| 5 | 设备切换对既有媒体元素失效（appliedMedia 缓存） | 高 | 改为 WeakMap 按设备记账，切换即重应用 |
| 6 | 隔离世界钩子（AudioContext/fetch/XHR）对页面主世界无效 | 高 | 新增主世界注入脚本 guest-mainworld.js（executeJavaScript + postMessage 桥） |
| 7 | 115MB electron-tmp.zip 与调试残留误入库 | 高 | git 历史重建为干净单提交，仓库 0.1MB |
| 8 | 歌词/进度上报无载荷上限 | 中 | 主进程限额（LRC ≤200KB 等） |
| 9 | 完整 URL（含 query/token）进工具栏与日志 | 中 | pushStatus/日志统一脱敏（origin+path） |

## 审查轮 2：安全与隐私审查

**范围**：权限/证书策略、IPC 越权、注入脚本、隐私泄漏面、URL 校验绕过、sandbox 完整性。

**关键发现与处置**：

| # | 发现 | 严重度 | 处置 |
|---|------|--------|------|
| 1 | setCertificateVerifyProc 默认拒绝一切证书（含合法 https） | 高 | 改为透传 Chromium 校验结果，仅开启「忽略证书错误」时放行 |
| 2 | 权限（含麦克风）按任意来源放行 | 高 | 权限仅放行已配置服务器主机；media 按 mediaTypes 收窄为音频 |
| 3 | IPC 无发送者校验；server:test 为 SSRF 原语 | 中 | 全部 handle/on 校验发送方（file:// renderer 白名单）；guest 上报校验来源主机 |
| 4 | 设置窗口无 will-navigate 防护 | 中 | 已拦截 |
| 5 | 仓库含真实内网地址的文本文件曾被误提交 | 高 | .gitignore 加固 + 历史重建，check-privacy 通过 |
| 6 | 生产包未显式关闭 devTools；data:clear 未清认证缓存 | 低 | devTools: !app.isPackaged；补 clearAuthCache；smoke 仅开发态 |

## 审查轮 3：代码质量与缺陷审查

**范围**：生命周期、WebContentsView 使用、竞态、guest-preload 健壮性、歌词窗口状态机、打包配置。

**关键发现与处置**：

| # | 发现 | 严重度 | 处置 |
|---|------|--------|------|
| 1 | 关闭主窗口后歌词窗口导致「僵尸进程」 | 高 | 主窗口 closed → app.quit() |
| 2 | 工具栏设备下拉被 guest 视图原生图层遮挡 | 高 | 设备选择统一收口到设置窗口（工具栏按钮跳转） |
| 3 | guest 视图在欢迎模式下提前创建 | 低 | 懒创建（首次 app 模式才创建） |
| 4 | MutationObserver 全树扫描性能风险 | 中 | rAF 去抖 + 单次查询 + 遍历预算 |
| 5 | 歌词窗口 IPC 重复注册隐患 | 中 | 一次性注册守卫 |
| 6 | 歌词窗口空白闪烁（未等加载完成即显示） | 低 | ready-to-show 后显示 |
| 7 | 拖动 IPC 载荷未校验 | 低 | 已补类型校验 |
| 8 | 注释/占位符残留（parseLrc:null、firstRun 死配置等） | 低 | 已清理 |

## 验证手段

- 无头测试套件：`npm test`（38 项，覆盖地址校验/设置/歌词解析与状态机/IPC 发送者校验/窗口管理/歌词嗅探）
- 隐私合规检查：`npm run check:privacy`（解析 git 索引，扫描 IP/凭据/个人配置）
- 冒烟测试：`npm run smoke`（需真实桌面环境与可达的服务器）
- 本仓库历史经重建，确认不含任何个人信息

## 审查轮 4：修复正确性验证（第二轮 A/B）

两路独立验证审查，确认 8 项修复正确（证书透传、权限主机校验、WeakMap 记账、主世界注入、看门狗、发送者校验、歌词限额、设备入口收口），并追加修复：

| # | 发现 | 处置 |
|---|------|------|
| N1 | did-fail-load 回退的 validatedURL 与配置 URL 存在尾斜杠差异，auto 回退可能不触发 | 双侧尾斜杠归一化比较 |
| N3 | 歌词窗口生产包未禁用 devTools | devTools: !app.isPackaged |
| N4 | media 混合 audio+video 请求会放行摄像头 | 含任何 video 类型即拒绝 |
| N5 | isTrustedOrigin 未比较端口 | 改为 origin 级比较（协议+主机+端口） |
| N6 | 已创建的 AudioContext 不随设备切换重定向 | 登记表 + 切换时重定向全部上下文 |
| N8 | 歌词窗口 IPC 无发送者校验 | 校验 sender 必须是歌词窗口页面 |
| 其他 | 空歌词不清理旧歌词、测试运行器不等待 async 导致竞态 | 空载荷清空歌词；测试改为顺序队列执行 |

## 验证手段（最终）

- 无头测试套件：`npm test`（52 项全过）
- 隐私合规检查：`npm run check:privacy`（41 个跟踪文件 0 违规，含 fn-connect 域名/点文件扫描）
- 打包验证：`electron-builder --dir`（win-unpacked）与 NSIS/portable 安装包均构建成功

> 注：本开发环境的沙箱限制（禁止子进程管道/信号管道）导致 Electron GUI 无法在此环境启动，
> 相关真机验证（cookie 持久化重启、真实设备切换、歌词捕获）需在用户正常桌面环境执行 `npm run smoke`。
## 审查轮 5：音频修复后三轮审查（A 音频正确性 / B 整体回归 / C 安全隐私）

审查轮 A（音频）：确认 suspend→setSinkId→resume 方向正确，修复 P1（iframe 切换失效——
preload 默认仅主 frame，改为设备切换时向全部 frame 广播 __fnmusicSetSinkNow）、P2（空设备
同步抛错导致永久静音——全链路 try/catch + resume 保证）、P3（并发切换串行化 epoch）、
P4（closed context 清理）、P5（suspended 幂等切换）、P6（新 context 构造期 sinkId 选项）、
P8（诊断聚合全部 frame + ctx.sinkId 真切换校验）、P11（framesInSubtree 注入）、P12（注入失败记录）。

审查轮 B（整体回归）：E1 已修（HEAD 测试桩 once + 提交工作区）；B6 托盘图标加入打包 files；
B3 托盘未创建时 second-instance 兜底；B12 歌词窗被系统关闭后开关状态同步；B1/B4 注释与定时器清理。

审查轮 C（安全隐私）：L1 日志 URL 脱敏（query/hash 剥离 + token 形参打码）；L2 诊断 logTail
展示前脱敏；L3 移除歌名日志；L4 日志 1MB 轮转留 5 份；L5 liveContexts 清理；L6 title 截断；
L7 托盘常驻行为文档化。隐私合规复检通过（43 文件 0 违规）。

## 审查轮 6：音频调节面板 + 音量系统 + 歌词捕获（三轮审查 A/B/C）

本轮功能：独立音频调节面板（设备即选即生效 + 音量滑块实时生效）、音量系统（WebAudio
master gain + 媒体元素双通道）、歌词捕获改进（全量 JSON 嗅探 + WebSocket 钩子 + 诊断统计）。

审查发现与处置：
- P0（C1/B1）：XHR 钩子引用已删除常量 LYRIC_URL_HINT，页面所有 XHR 请求崩溃——已修复并补充浏览器桩回归测试（60 项套件）；
- P1（B2/M1）：音量周期性强制写回媒体元素，覆盖页面自身音量控件——改为仅在显式指令时应用；
- H1：WebSocket 钩子破坏 removeEventListener/once、onmessage 未覆盖——WeakMap 双向映射 + onmessage 属性钩子 + options 透传 + 二进制帧解码；
- H2/B3：动态 iframe 注入不回放音量——注入后并列回放设备与音量；
- M2：destination 换包后 disconnect() 会导致静音——master.disconnect 拦截自动重连；类型差异接受并注记；
- B4：音量滑块高频 IPC/写盘——rAF 节流；B5：全 JSON 嗅探无预算——text() 长度预检 + 字段变体放宽；
- L1：NaN 音量静音不一致——各层 Number.isFinite 校验，非法载荷忽略；
- WebAudio 时间轴：纯 WebAudio 播放器无媒体元素、进度恒 0——主世界按 ctx.currentTime 上报；
- 安全：面板窗口补齐 setWindowOpenHandler；诊断 frame.url 脱敏；IPC 校验复检通过；
- 隐私：check-privacy 通过；新增文件无敏感信息。

## 审查轮 7：桌面歌词移除 + 登录态修复 + 黑屏自愈（v0.1.6）

- **桌面歌词移除**：多轮尝试（JSON 嗅探/WebSocket/DOM 捕获/时间轴）无法稳定获取飞牛音乐歌词，
  按用户授权完整移除（lyrics.js/歌词窗口/捕获钩子/IPC/UI 入口），注入脚本回归纯音频职责；
- **登录态修复**：根因定位为便携版/多形态 userData 路径不一致（exe 移动/删除即丢数据），
  固定 userData 为 %APPDATA%\FNMusicPC；启动日志输出 userData 路径与 Cookie 文件状态；
  诊断接口返回 cookie 数量；保留 60s 周期 flush + 退出双 flush；
- **黑屏自愈闭环**：ready-to-show 超时（渲染异常）时，若用户未显式配置硬件加速，
  自动切换软件渲染并提示重启（另一台电脑安装版黑屏的针对性修复）；
- 测试套件调整至 48 项（歌词相关用例移除，音频/登录/降级逻辑保留覆盖）。
