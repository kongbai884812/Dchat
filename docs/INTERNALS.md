# 实现细节与排障

本文是给要改代码或核对实现的人看的。只想装来用的话看 [README](../README.md) 就够了。

## 拍照 / 相册 / 文件

demo 自带完整附件链路：`input[type=file] multiple` → `POST {base}/anthropic/v1/files`（`x-api-key` + `anthropic-beta: files-api-2025-04-14`）→ 消息里带 `{type:"image",source:{type:"file",file_id}}`。它缺的是**入口**，`www/camera.js` 补这一环，不改打包产物。

### 入口

左下悬浮按钮 → 底部三格：**📷 拍照 / 🖼 相册 / 📎 文件**（对齐 DeepSeek App 的面板）。

### 拍照：App 内自绘取景器

- 顶部「✕ / 📷 图像识别 / ⟳ 切换摄像头」
- 中间 `getUserMedia` 实时取景（`<video playsinline muted>`）
- 取景器内**双指捏合变焦**（1–4×，软件实现：CSS 缩放画面 + 快门时中心裁切，保证拍到的就是看到的）
- 底部 ⚡ 闪光灯（`torch` 约束）、白色快门、🖼 直达相册
- 快门 → canvas 抓帧（长边 1600 / JPEG 0.92）→ **预览页**
- 预览页：大图 + 快捷 chips「这是什么 / 分析一下 / 怎么办 / 解释一下」+「重拍 / 完成」。点 chip 会把图入列、并把文案填进输入框（用原生 setter + `input` 事件，兼容 React 受控组件）

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

### Manifest 需要两项

```xml
<!-- App 内相机走 getUserMedia，必须声明（Capacitor 会转成运行时权限框） -->
<uses-permission android:name="android.permission.CAMERA" />

<!-- 系统相机兜底路径需要，否则 Android 11+ resolveActivity() 返回 null -->
<queries>
    <intent><action android:name="android.media.action.IMAGE_CAPTURE" /></intent>
</queries>
```

权限由 `BridgeWebChromeClient.onPermissionRequest()` 处理：检测到 `VIDEO_CAPTURE` 就申请 `CAMERA`，授权后 `request.grant()`，拒绝则 `deny()` —— 拒绝后自绘相机会失败并自动回退系统相机。

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

## 已知没做的

- **圈选区域提问**：官方 App 拍照后可在图上圈一块再问。需要 canvas 选区 + 裁剪/坐标回传，属于产品功能，暂未实现。
- **微信文件**：需要微信 SDK 的分享入口，纯 WebView 做不到。

## 白屏排查表

| 现象 | 原因 | 处理 |
|---|---|---|
| 整页白 + diag 说 `import()` 被拒 | `file://` 加载 | 换 Capacitor / 本地 http |
| 白屏但有布局 | 首屏请求失败 | 看 diag 的跨域/网络两行 |
| 能用但发消息报 `Failed to fetch` | key 没填 / 被限流 | 设置里填 key |
| `ERR_CLEARTEXT_NOT_PERMITTED` | 用了 `http://` | 改 https |
| 装不上、解析包错误 | 老 targetSdk | 本工程 36，重打 |

`www/index.html` 里额外加了两段排障代码，稳定后删掉即可：

1. 6 秒内 `#root` 还是空的 → 盖一层错误面板，把捕获到的脚本错误、origin、协议都打出来，并给出诊断页链接；
2. 右下角一个半透明 `?` → 直达 `diag.html`（打包后没有地址栏，这是唯一入口）。
