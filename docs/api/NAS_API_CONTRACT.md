# NAS 音乐接口契约：阶段 1A–1B

日期：2026-09-11。范围：认证机制分析、已登录读取、原始音频播放、受控 HLS 转码任务验证。

本记录来自用户指定实例的公开前端代码与受控请求，不是厂商公开承诺的稳定 API。服务器升级后需要重新验证。只记录路径、结构和状态，不记录服务器地址、账号、歌曲名称、GUID、Cookie、令牌、签名常量或原始响应。

## 1. 本轮结果与边界

- 以独立 Chrome 配置目录建立会话，由用户手动完成登录；没有读取或输入密码，没有导出 Cookie、完整 HAR 或浏览器配置。
- 已实测：系统配置、初始化状态、当前用户、曲库第一页、单曲元数据、原始音频的首段读取。
- 原始流返回 HTTP 206、`audio/flac` 及有效 `Content-Range`，采样统计为 1024 字节，没有保存音频内容。
- 阶段 1B 新增实测：非零偏移 Range、浏览器 FLAC 元数据/跳转/静音播放进度、页面刷新后的会话、HLS 转码创建与结束、初始化段和首个媒体分段读取。
- 尚未实测：独立原生客户端登录、应用重启/续期/失效、Windows 原生解码、整首曲目播放、长时间 HLS 心跳与解码、其他音频格式、FN Connect 外网链路。
- **阶段 1 尚未全部完成。** 本轮完成认证与原始音频链路的第一批证据，不能视为 WinUI 3 播放验收。

## 2. 路由与响应约定

当前主业务 API 前缀为 `/music/api/v1`。前端还定义了 v2 和国际版通道；本轮没有验证这些通道，不自动切换。

普通业务响应为 `{ code, msg, data }`。前端解析器接受业务码 `0` 或 `200` 为成功；实际成功响应观察到 `0`。HTTP 状态和业务码应分别判断，不能只看 HTTP 200。

未登录的 `/user/me` 实际返回 HTTP 401、业务码 `99999`；前端还定义了 `120001` 为未授权。因此不能仅用 `code === 120001` 判断登录失效。

| 方法 | 相对 API 路径 | 请求结构/作用 | 证据 |
| --- | --- | --- | --- |
| GET | `/sys/config` | 无参数；data 含 nasOAuth、serverGUID、serverName、serverVersion、mediasrvVersion | 未登录实测 200/code 0，仅保留字段名 |
| GET | `/initialization/state` | 无参数；data.initialized | 未登录实测 200/code 0，已初始化 |
| POST | `/user/password-login` | JSON：username、password、deviceId | 静态确认，未独立回放 |
| POST | `/user/auth-login` | JSON：code、deviceId | 静态确认 NAS OAuth code 兑换，未独立回放 |
| GET | `/user/me` | 无参数 | 登录后实测 200/code 0；不带会话实测 401 |
| POST | `/user/logout` | 前端调用没有传业务参数 | 静态确认，未退出用户会话 |
| GET | `/track/list` | query：page、size，可选 sort | 实测 page=1、size=1 返回 200 |
| GET | `/track/metadata` | query：guid | 实测 200 |
| GET | `/track/stream` | query：guid；HTTP Range | 实测 bytes=0-1023 返回 206 |

## 3. 登录与会话

### 密码入口（静态）

前端先检查 initialized 与 allowPasswordLogin 等引导状态，再提交密码登录。密码字段经过 SHA-256 转换后发送，deviceId 为本机持久的 32 位十六进制标识。具体输入规范化、错误限制和账户权限仍需对照实际登录测试，不能只根据表单文案推断。

SHA-256 后的密码仍属于敏感认证材料，禁止日志记录或当作普通设置存储。不要将它理解为 TLS 的替代方案。

成功处理代码期望 `{ userToken, user }`，随后将 userToken 写入名为 `music-token` 的 Cookie，代码声明 `Path=/; SameSite=Strict`，未声明 Expires/Max-Age。该静态线索不证明令牌的服务端有效期，也不证明浏览器或原生客户端重启后必然有效。

没有确认到独立 refresh 接口。原生实现应先验证已保存会话，再决定重新登录，不能自行假设可无限续期。

### NAS OAuth 入口（静态）

前端从系统配置的 nasOAuth 获取 clientId 与入口，构造 `/signin`，参数含 client_id、redirect_uri、app_name；网页回调为 `/music/oauth/result`，再以 code 和 deviceId 兑换音乐用户令牌。

WinUI 原生回调尚未得到证实：不能自行将网页 redirect_uri 改成自定义协议或 loopback 地址并假设服务端接受。阶段 1B 应验证官方支持的回调方案及外网入口。初始化 prepare/confirm 属于设置服务的操作，本轮没有调用。

### 请求签名与 Cookie 的区别

前端业务 API 客户端会添加 `authx`，形式为 nonce、timestamp、sign。静态实现使用 MD5，并对请求路径、规范化 query 或 JSON body、时间戳、随机数及应用级材料进行计算。

GET 的规范化包含参数排序、空值处理和 URL 编码/解码；POST 基于实际序列化的 JSON。未来跨语言实现必须使用合成测试向量对照中文、空格、数组和字段顺序。应用级签名材料未写入本仓库；其版本变化与分发方式仍待确定。

**签名出现不等于它在所有接口上强制要求：**

| `/user/me` 受控对照 | HTTP | 业务码 |
| --- | --- | --- |
| 已登录浏览器默认 API 客户端，带 authx | 200 | 0 |
| 同一浏览器直接 GET，携带现有 Cookie、不带 authx | 200 | 0 |
| 同一浏览器直接 GET，credentials=omit、不带 authx | 401 | 99999 |

因此，当前实例的 `/user/me` 可在无 authx 时凭浏览器 Cookie 会话成功。此结果不能推广到所有接口，也未证明哪个 Cookie 独立充分；未提取 Cookie 做拆分实验。

## 4. 曲库和播放数据

实测 `/track/list` 返回 data.list 数组与数值型 data.total。单曲标识使用 guid，不应将服务器文件路径当作稳定 ID。客户端静态代码还读取 title、artists、album、coverId、isFavorite、isCue、audioSpec 等字段，这些字段的完整类型/可空性尚未逐个实测。

实测 `/track/metadata` 返回 track 与 audioSpec 对象，以及数值型 audioSpec.duration。前端将 API duration 除以 1000 转换为秒；createdAt/updatedAt 的显示代码则乘以 1000。未来 DTO 必须明确不同时间字段单位，避免全局统一换算。

### 原始音频

播放提供器先查询元数据，再选择 `/track/stream?guid=…` 或服务器转码。本轮直接流请求没有 authx，使用页面现有同源 Cookie，返回 206。

原生验证下一步应覆盖：受控传递鉴权、首段与非零偏移 Range、音频时长、拖动进度、取消请求、切歌释放、失效会话、重定向来源校验、WinUI/Windows 播放器 FLAC 解码。206 只证明本次分段传输，不证明完整播放器可用。

### HLS 转码（静态，未发起任务）

1. POST `/track/transcode`，JSON 为 `{ guid, output: { codec, bitrate, channel } }`。
2. 前端处理 status=success/ready/failed，失败时可能带 errno/errmsg。
3. 播放 `/track/hls/{guid}/preset.m3u8`。
4. 约每 10 秒 POST `/track/transcode/heartbeat`，包含 guid 与 timestamp；timestamp 的具体业务含义待验证。
5. 释放时 POST `/track/transcode/quit`，包含 guid。

所检查质量映射的 codec 为 flac，bitrate 有 128/256/320 分支。它不能直接证明输出容器或 Windows HLS 解码支持；需读取真实清单和媒体类型。CUE 与部分格式会影响转码选择。

前次发现的 `/api/stream/unified`、`/api/stream/info`、`/api/stream/hls` 属于其他静态播放策略线索，本轮实际提供器调用与网络证据指向上述 `/music/api/v1/track/*`。不能将两套路径混用。

## 5. 后续功能路径清单（静态）

| 能力 | GET 路径 | 写入路径（未调用） |
| --- | --- | --- |
| 专辑/歌手 | `/album/list`、`/album/detail`、`/artist/list`、`/artist/detail` | 不在当前探测范围 |
| 搜索 | `/search/track`、`/search/album`、`/search/artist`、`/search/playlist`、`/search/suggest` | 不调用重建索引 |
| 收藏 | `/favorite-track/list` | POST `/favorite-track/create`、`/favorite-track/delete` |
| 歌单 | `/playlist/list`、`/playlist/detail` | POST `/playlist/create`、`/playlist/edit`、`/playlist/delete`、`/playlist/add-track`、`/playlist/remove-track` |
| 历史 | `/play-history/list` | POST `/play-history/delete` |
| 歌词 | `/lyric/list` | 未确认 |

这些路径只用于后续定位。请求参数、分页、所有权、权限和响应模型需逐项验证，不能直接作为“功能已支持”的依据。

## 6. 可重复诊断与隐私边界

`scripts/nas-browser-probe.js` 可在已登录音乐页面控制台运行；本轮通过用户授权的独立 Chrome 调试会话执行同一函数。它只加载当前页面已加载、同源且文件名匹配的已审查 API 模块，复用页面认证，不读取凭据值。

脚本仅请求当前用户、最多一首歌曲及其元数据和首段音频。输出使用固定字段/枚举白名单，不输出个人数据、服务器 URL、原始异常文本、歌曲 GUID 或内容。若服务器更新导致模块标识变化，应重新审查适配，不能盲目改为任意模块匹配。

脚本统计最多 1024 字节并取消流；服务器或浏览器网络缓冲可能接收更多，不能宣称网络传输硬上限为 1024 字节。它没有执行声音播放，也没有创建转码任务、修改歌单或退出会话。它是探查工具，不是原生客户端实现。

自动化测试覆盖输出脱敏、跨来源模块拒绝、认证失败短路、空曲库和 Range 误判。原始探查材料在 `.review-audit/`，Chrome 配置在 `.chrome-debug/`，两者均被 Git 忽略。最终打包仍须检查产物，不能以忽略规则代替发布审查。

## 7. 阶段 1B 实测补充（优先于前文静态状态）

### 不带 authx 的业务请求

以下请求在当前登录浏览器中以直接 fetch、同源 Cookie、无 authx 执行成功：

| 请求 | 实际结果 |
| --- | --- |
| GET `/user/me` | HTTP 200 |
| GET `/track/list?page=1&size=1` | HTTP 200 |
| GET `/track/metadata?guid=…` | HTTP 200 |
| GET `/track/stream?guid=…`，Range 为 bytes=4096-5119 | HTTP 206，Content-Range 起止位置完全匹配 |
| POST `/track/transcode` | HTTP 200，业务结果 status=success |
| POST `/track/transcode/quit` | HTTP 200，结束请求成功 |

原生最小验证工程可首先对这些已验证端点使用会话认证，不应提前复制网页签名常量或混淆密钥。密码登录、写歌单等未测接口是否要求签名仍未知；不能泛化为整个 API 无需签名。

### 浏览器实际播放

新增 `scripts/nas-media-probe.js`：读取第一页最多一首歌曲，验证非零偏移 Range，再创建独立的静音 Audio。实测读到有限正时长，跳转成功，播放位置前进超过 0.25 秒，最后暂停并移除音源。没有改变音乐页面队列，没有保存歌曲或账号内容。

首次探查因页面不可见而发生媒体加载超时。通过 CDP 临时焦点模拟后，同一流成功完成测试；结束时关闭焦点模拟。该结果不能作为普通后台播放体验已通过的证据。

整理成可重复脚本时还发现一次测试逻辑竞态：loadedmetadata 之后主动 pause 会使早先的 play Promise 拒绝。已区分主动暂停与初次播放失败，并增加回归测试。超时、拒绝播放及清理异常都不得被报告为成功；即便 pause 抛错，也继续尝试移除音源。

### HLS 任务与资源

在页面没有正在播放的 audio/video 时，分别通过前端 API 客户端及不带 authx 的直接请求，创建短暂测试转码任务。参数使用已观察的 `{ guid, output: { codec: "flac", bitrate: 320, channel: 2 } }`。

两次结果一致：status=success；preset.m3u8 是带 `#EXTM3U`、`#EXTINF`、`#EXT-X-MAP` 与 `#EXT-X-ENDLIST` 的媒体清单，不是主清单。初始化段与首个媒体段均返回 HTTP 200，首部可识别为 MP4 盒结构。两次测试均成功调用 quit。

HLS 资源即使收到 Range 请求也可能返回 200，本轮不能声称这些资源支持 Range。没有完成 HLS 解码或长时间播放，没有验证心跳 timestamp 的具体语义；原始 FLAC 的播放成功不能替代 HLS 兼容性测试。

### 会话属性与恢复

只输出了 music-token 的属性：session=true、HttpOnly=false、Secure=false、SameSite=Strict、Path=/。本次连接使用 HTTP。没有输出或保存 Cookie 值、域名或其他 Cookie 属性。

刷新音乐页面后，`/user/me` 仍返回 200。这仅验证页面刷新恢复，未验证浏览器进程重启或 WinUI 重启。新客户端应加密保存自身取得的会话令牌，按连接目标隔离，并在启动时调用 `/user/me` 验证；无有效会话时清理状态并回到登录界面。用户选择不记住登录时不持久保存令牌。

### 接下来进入最小原生工程

传输层已有足够证据开展 WinUI 3 验证，无需继续遍历全部网页脚本。认证与原生媒体边界见 [原生认证和播放决策](../NATIVE_AUTH_PLAYBACK_DECISION.md)。后续依赖真实原生工程的项目仍保留为验收关卡，不将浏览器探查标成原生完成。
