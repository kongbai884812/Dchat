# 实现细节与排障

本文是给要改代码或核对实现的人看的。只想装来用的话看 [README](../README.md) 就够了。

## 拍照 / 相册 / 文件

demo 自带完整附件链路：`input[type=file] multiple` → `POST {base}/anthropic/v1/files`（`x-api-key` + `anthropic-beta: files-api-2025-04-14`）→ 消息里带 `{type:"image",source:{type:"file",file_id}}`。它缺的是**入口**，`www/camera.js` 补这一环，不改打包产物。

### 入口

输入框右下角的「+」→ 面板**在卡片内部展开**（不是带遮罩的浮层），三格：**📷 拍照 / 🖼 相册 / 📎 文件**；展开时加号旋转 45° 变成叉，卡片向上撑高把聊天内容顶上去。面板由 React 渲染（`ChatInput`），`camera.js` 只提供三个隐藏的 `input` 和相机，通过 `window.__dchatPick('camera'|'gallery'|'file')` 被调用。

### 拍照：App 内自绘取景器

- 顶部「✕ / 📷 图像识别 / ⟳ 切换摄像头」
- 中间 `getUserMedia` 实时取景（`<video playsinline muted>`）
- 取景器内**双指捏合变焦**（1–4×，软件实现：CSS 缩放画面 + 快门时中心裁切，保证拍到的就是看到的）
- 底部 ⚡ 闪光灯（`torch` 约束）、白色快门、🖼 直达相册
- 快门 → canvas 抓帧（长边 1600 / JPEG 0.92）→ **预览页**
- 预览页：左上「✕」退出、右上「⛶」裁剪；中间大图；底部一排快捷 chips「这是什么 → / 分析一下 → / 怎么办 → / 解释一下 →」；再往下是**自己的输入行**：`+` / 麦克风（切语音时变键盘）/ 发送箭头三个小圆钮并排（30px），
所以拍完照**不写字也能直接发送**；切到语音时中间那颗变键盘，按住说话复用主页面录音（`__voice*` 钩子）。点 chip 或点发送 = 图入列 + 文案填进去（原生 setter + `input` 事件，兼容 React 受控组件）+ 自动点发送

**失败一律回退系统相机**：`getUserMedia` 不可用或抛错（老 ROM 黑屏、权限被拒）→ 自动改走 `<input capture="environment">`，不会卡住。

### 相册 / 文件

- 相册：`<input type="file" accept="image/*" multiple>`，一次多选，本批上限 `MAX_BATCH = 200`
- 相册/拍照选完走 `handleFiles`：超过 1.2MB 压到长边 1600 / JPEG 0.85，`heic` 等 demo 不认的格式转 jpeg
- **文件入口不压缩、不过滤**，原样交给 demo：zip / html / pdf 是否可传由 demo 的白名单决定，提示也由它弹出。自己先过滤会吞掉「不支持该格式」的提示，表现为点了没反应

> `input.files` 返回的是**活的 FileList**。先取引用再 `input.value = ""`，拿到的会变成 0 个文件。
> 必须 `Array.prototype.slice.call(input.files)` 先拷成数组。

#### 附件缩略图上的删除按钮

demo 自带删除按钮，但样式是给桌面写的：

```css
.remove-ed6f47{opacity:0}
.attachment-ed6f47:hover .remove-ed6f47{opacity:1}
```

手机没有 hover，所以永远看不见。`camera.js` 用一段 CSS 覆盖成常显的红色圆形 ×：

```css
.attachment-ed6f47 .remove-ed6f47{
  opacity:1!important; width:20px; height:20px;
  top:2px; right:2px; background:#ff3b30!important;
}
```

只改样式，点击仍走 demo 自己的删除函数。

> 这段样式必须**在脚本启动时注入**（`injectCamCss()`）。它原本只写在 `buildCam()`
> 和 `showPreview()` 里，而「添加 → 相册」这条路径不会调用它们，导致规则从未生效。

`ed6f47` 是 CSS Modules 对 `ChatInput.module.css` 的哈希，由**文件路径**决定（不是内容），
所以重新构建前端不会变；但如果换了构建工具或改了文件路径，这里写死的类名会静默失效
（表现：缩略图上的删除叉又不见了），改完前端记得核对 `www/static/css/main.*.css` 里的实际类名。

### 投喂给 demo

找到 demo 自己的上传 `input`，用 `DataTransfer` 赋 `input.files` 后派发 `change`，React 的 `onChange` 照常跑；找不到 input 时退回合成 `paste`（textarea）/ `drop`（document）事件，并最多等 3 秒等它渲染。

### 数量限制是两道

| 来源 | 原值 | 现值 |
|---|---|---|
| demo 自身（`t + e.length > 50`） | 单条消息 50 个附件 | **已补丁为 200** |
| demo 自身（`C()`：`user_data` 32MB，其余 64MB） | 单文件 32 / 64MB | 未改 |
| `camera.js` 的 `MAX_BATCH` | 每批 20 张 | **200** |
| `System Photo Picker` 的 `EXTRA_PICK_IMAGES_MAX` | 20 | **200**（系统按机型上限自动收敛） |

前三条都是客户端自己设的检查，不是服务端的限制。真正的天花板在服务端，超过它会在上传阶段报错——那时把 `200` 往下调即可。

补丁落在 `www/static/js/main.*.js` 里这一处（全文唯一）：

```diff
- t+e.length>50?{key:"uploadMaxFiles",params:{count:50}}
+ t+e.length>200?{key:"uploadMaxFiles",params:{count:200}}
```

> 注意：上面 diff 里出现 `50` 是为了展示改动前后，**当前代码已是 200**。

改的是上线数字和提示文案里的 `{count}` 占位符，两处必须一起改，否则弹出的提示会说错数字。

### Manifest 需要三项权限 + 一条 queries

```xml
<!-- App 内相机走 getUserMedia，必须声明（WebView 的 VIDEO_CAPTURE 请求会转成运行时权限框） -->
<uses-permission android:name="android.permission.CAMERA" />
<!-- 按住说话录音，WebView 的 AUDIO_CAPTURE 请求同样转成运行时权限框 -->
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<!-- WebRTC 音频路由；缺了部分机型 getUserMedia 直接 NotReadableError -->
<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />

<!-- 系统相机兜底路径需要，否则 Android 11+ resolveActivity() 返回 null -->
<queries>
    <intent><action android:name="android.media.action.IMAGE_CAPTURE" /></intent>
</queries>
```

权限由 `MainActivity` 里的 `WebChromeClient.onPermissionRequest()` 处理：识别 `VIDEO_CAPTURE` / `AUDIO_CAPTURE`，缺哪个就 `requestPermissions()` 申请，全部同意才 `request.grant()`，否则 `deny()` —— 拒绝后自绘相机自动回退系统相机，录音则提示无权限。

## 历史导入：会跳过图片

DeepSeek 官方导出的是 `deepseek_data-日期.zip`，里面有会话 JSON，也有 `chat_sessions/*_files/`（聊天里发过的所有图片原件）。一个长期使用的账号，这个包很容易到几百 MB——实测 211MB 会直接把 WebView 卡死。

处理方式是在原生层**流式精简**再交给页面：用 `ZipInputStream` 顺序读，跳过名字里带 `_files/` 的条目，其余原样写进一个新的小 ZIP，再把这个小包交给页面导入。读和写都用 128KB 缓冲，内存占用和原包大小无关。

**代价：导入后历史消息里的图片会缺失。**

| | 结果 |
|---|---|
| 文字、思考、工具调用、消息树 | ✅ 完整 |
| 历史图片 | ❌ 只能看到文件名和大小，点开是空白 |
| 重新发送旧图片给模型 | ❌ 做不到 |

demo 本身能接受附件缺失（保留元数据、不参与后续请求），所以导入不会失败。

如果你需要图片，有两条路：

1. 自己重写一整套流式 ZIP 导入（社区里有项目这么做，保留附件全量导入，但那需要改前端源码并重新构建）
2. 按需回填——保留原 ZIP，点开某条消息时再解压对应条目（未实现）

## 语音输入：按住说话

前端在 `usePushToTalk` 里做状态机（`idle` / `recording` / `transcribing`），UI 是 `HoldToTalk`：

1. 按下开始 `getUserMedia`，`ScriptProcessor` 采集 PCM，编码成 16kHz 单声道 WAV；
2. 松手结束：录音短于 700ms 直接丢弃并提示「说话时间太短」；
3. 否则 `POST /v1/tools/asr`（multipart WAV，上限 120s / 8MiB），成功即自动发送；
4. 按住时上移超过 56px 进入取消区，松手丢弃录音、不发送。

**这台机器上的两个坑**（都已在代码里处理）：

- `getUserMedia` 带 `echoCancellation` / `noiseSuppression` 会直接抛 `NotReadableError: Could not start audio source`。现在按「带处理 → 默认 → 全关处理」三档退让，并记住成功的那一档（`preferredVariant`），后续直接命中。
- 首次打开麦克风要 1~2 秒，按住一两秒根本等不到。进入语音模式时先 `primeMicrophone()` 把流打开并**留着**（`warmStream`），按下时直接复用，退出语音模式才释放。

权限声明见上面「Manifest 需要三项权限 + 一条 queries」。

## 界面语言：别把中文写死

`camera.js` 是独立脚本，读不到 React 的 i18n 上下文，所以它自己维护一份
`I18N`（49 个键，中英各一套）并现读 `localStorage['chat-demo:locale']`；
没有这个键时**跟随系统语言**（和 `services/settings.ts` 的 `initialLocale()` 同一规则）：

- `t('hold')` 取文案，切到英文后立刻生效，不用重启；
- 取景器标题在每次打开时刷新，预览页在语言变化后**重建 DOM**（`box.__locale` 记着上次语言）；
- 新增文案时两个语言包都要加，漏了会退回中文。

### aria-label 也别写死

demo 的按钮没有稳定的 id，能被外部脚本稳拿的标识就是 `aria-label`，而它的文案跟着界面语言走：

| 用途 | 中文 | 英文 |
|---|---|---|
| 发送 | 发送 | Send |
| 深度思考 | 深度思考 | DeepThink |
| 智能搜索 | 智能搜索 | Search |
| 侧边栏 | 打开边栏 | Open sidebar |
| 上传 | 上传文件 | Upload files |

`camera.js` 里所有跨到聊天页的选择器都走 `byLabel(['中文', 'English'])`（顶部 `LABELS` 表），
不再写死中文。历史坑：`autoSend()` 以前只匹配 `[aria-label="发送"]`，切到英文界面后
预览页发图会一直等不到按钮，表现为「点了没反应」；深度思考/智能搜索两个开关同理。

## 附件面板与拍照预览页

- 输入框右下角三合一按钮：无文字=麦克风、有文字=发送、语音模式=键盘；`+` 在卡片内展开面板（拍照/相册/文件），展开时加号旋转 45° 变成叉，卡片向上撑高把聊天内容顶上去，不再用全屏遮罩。
- `www/camera.js` 不再自己画面板，只提供三个隐藏输入源和相机，通过 `window.__dchatPick('camera'|'gallery'|'file')` 被调用；React 侧用 `__openAttachPanel` / `__closeAttachPanel` 与它联动。
- 拍完的预览页：左上退出、右上裁剪、底部一排快捷提问，输入框复用主界面的同一套交互——它是通过 `window.__voiceStart / __voiceFinish / __voiceCancel / __voiceWarm / __voiceRelease / __voiceSetSink` 直接借用 React 里的录音引擎，识别结果回填到预览页的输入框，点发送才真正发出去。

## 已知没做的

- **圈选区域提问**：官方 App 拍照后可在图上圈一块再问。裁剪（拖框、四角手柄）已经做了，但还不能把框选区域作为坐标提问。
- **微信文件**：需要微信 SDK 的分享入口，纯 WebView 做不到。

## 白屏排查表

| 现象 | 原因 | 处理 |
|---|---|---|
| 整页白 + diag 说 `import()` 被拒 | `file://` 加载 | 必须走 `https://localhost` 或本地 http |
| 白屏但有布局 | 首屏请求失败 | 看 diag 的跨域/网络两行 |
| 能用但发消息报 `Failed to fetch` | key 没填 / 被限流 | 设置里填 key |
| `ERR_CLEARTEXT_NOT_PERMITTED` | 用了 `http://` | 改 https |
| 装不上、解析包错误 | 老 targetSdk | 本工程 36，重打 |

`www/index.html` 里额外加了两段排障代码，稳定后删掉即可：

1. 6 秒内 `#root` 还是空的 → 盖一层错误面板，把捕获到的脚本错误、origin、协议都打出来，并给出诊断页链接；
2. 右下角一个半透明 `?` → 直达 `diag.html`（打包后没有地址栏，这是唯一入口）。
