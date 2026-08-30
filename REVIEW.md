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

- 无头测试套件：`npm test`（41 项全过）
- 隐私合规检查：`npm run check:privacy`（41 个跟踪文件 0 违规，含 fn-connect 域名/点文件扫描）
- 打包验证：`electron-builder --dir`（win-unpacked）与 NSIS/portable 安装包均构建成功

> 注：本开发环境的沙箱限制（禁止子进程管道/信号管道）导致 Electron GUI 无法在此环境启动，
> 相关真机验证（cookie 持久化重启、真实设备切换、歌词捕获）需在用户正常桌面环境执行 `npm run smoke`。