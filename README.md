# Dchat

把 DeepSeek 开源的 [chat-demo](https://github.com/deepseek-ai/chat-demo) 打包成**可安装的 Android APK**（约 1.9MB）。
自带相机、相册、文件三个入口，「按住说话」语音输入，聊天记录可导入，构建全程可以在手机上完成。

> **非官方项目**：与 DeepSeek 官方无任何关联，未获授权或背书。"DeepSeek" 是其权利人的商标，
> 本项目不使用该名称或标识作为自身品牌。前端来自 DeepSeek 开源的 chat-demo（MIT）。

## 维护状态

**个人自用项目，随缘更新维护。**

- issue 提了能看，但不保证回复速度
- PR 看情况合并，不承诺合入时间
- 新功能视自己用不用得上，没有路线图
- 想改就自己 fork，MIT 协议下随意

唯一请求：**改了之后别用 `Dchat` 这个名字和图标发布**，避免和本仓库混淆。

## 概览

| 项 | 值 |
|---|---|
| 上游源码 | [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo)（MIT），可自行构建前端 |
| appId | `app.dchat` |
| minSdk / targetSdk | 24 / 36 |
| 资源加载 | `https://localhost` 映射到应用内资源，**不是 file://** |
| 构建 | `native-shell/build.sh`：aapt + javac + d8 + zipalign + apksigner，无需 Gradle |
| 版本 | 见 `native-shell/AndroidManifest.xml`（`versionCode` / `versionName`） |
| APK 体积 | 约 1.9MB |

两个关键结论：

- **不会白屏**：页面用 `https://localhost` 加载，等同正常网站，动态 `import()` 和 IndexedDB 都可用。
- **不用代理**：接口允许 WebView 直连，填自己的 key 就能用，不需要后端中转。

## 能做什么

页面主体沿用上游 chat-demo，输入区按官方客户端重做过：附件「+」、右下角三合一按钮（发送 / 麦克风 / 键盘）、
「按住 说话」、拍照后的预览页，都是在这个仓库里改的，其余视觉保持原样。

| 能力 | 实现方式 |
|---|---|
| 拍照 | 应用内 `getUserMedia` 取景器：快门、前后摄切换、双指捏合变焦（1–4×）、相册入口 |
| 拍照后 | 预览页独立输入行：左上退出、右上裁剪、快捷提问，`+` / 麦克风（切语音变键盘）/ 发送箭头并排，不写字也能直接发 |
| 相册选图 | 系统 Photo Picker（Android 13+），支持多选、无需存储权限 |
| 文件选择 | Storage Access Framework，接入系统文件管理器 |
| 附件面板 | 输入框内展开（拍照 / 相册 / 文件），加号旋转成叉，不遮挡输入区 |
| 语音输入 | 「按住 说话」：按住收音、松手转写并直接发送、上滑取消；接口走 `/v1/tools/asr` |
| 诊断入口 | 顶栏问号打开 `diag.html`，可查版本、网络、存储与历史导入结果 |
| 键盘适配 | 读取 `WindowInsets.Type.ime()` 动态抬高输入区，不遮挡输入框 |
| 顶栏与手势条 | 仅隐藏状态栏并读取刘海高度，底部手势条跟随系统设置 |

已知差别：历史导入会跳过图片、圈选提问未实现。细节见 [docs/INTERNALS.md](docs/INTERNALS.md)。

## 安装

APK 由本地 keystore 自签名，未经应用商店或厂商实名认证。安装时系统会弹安全提示，属于正常现象，**选「仍然安装」即可**。

| 厂商 | 提示文案 | 处理 |
|---|---|---|
| 华为 / 荣耀 | 未验证应用提醒 · 身份未经核实 · 签名来源不明 | 点「仍然安装」；想彻底关闭可关掉「纯净模式」 |
| 小米 / Redmi | 未知来源应用 | 允许本次安装 |
| OPPO / vivo / 一加 | 未经安全检测 / 风险提示 | 继续安装 |
| 三星 / 原生 Android | Install unknown apps | Allow |

签名证书由 `native-shell/build.sh` 首次运行时生成，之后**一直复用同一个**，所以能覆盖安装、数据不丢。

## 自己构建

**一条路径**：`native-shell/build.sh`，aapt + javac + d8，不需要电脑和 Gradle，手机上就能出包 → [docs/BUILD.md](docs/BUILD.md)

想用 Android Studio 的话按 `npx cap add android` 现场生成原生工程，再把 `MainActivity.java` 覆盖进去，步骤见同一篇文档。

## 代码透明度

没有混淆、没有遥测；**代码本身不加密**，但你自己填的 API Key 会用 Android Keystore 加密后落盘（见下表）。

| 项 | 状态 |
|---|---|
| Java 代码 | 779 行，纯 framework API，D8 编译而非 R8 minify，类名原样保留 |
| `www/camera.js` | 1618 行未压缩源码，APK 内与仓库内文件 **sha256 一致** |
| 加密逻辑 | API Key 用 Android Keystore 里的 AES-256（不可导出密钥）+ AES/GCM 存 `SharedPreferences`，明文不写 `localStorage`；除此之外没有自造加密，跨 JS 桥传二进制用的是 Base64 |
| 网络请求 | 仅 demo 自己发往 `api.deepseek.com`，不经过任何中转服务器 |
| 数据上报 | 无。不收集设备信息、不埋点、不联第三方 SDK |
| 隐私 | 聊天记录存本地 IndexedDB；API Key 存原生侧加密后的 `SharedPreferences`。两者都不出设备 |

验证方式：

```bash
# 类名有没有被混淆
unzip -p dchat.apk classes.dex | strings | grep "Lapp/dchat/"

# 前端资源与仓库是否一致
unzip -p dchat.apk assets/public/camera.js | sha256sum
sha256sum www/camera.js
```

## 目录

```
chat-demo-app/
├── www/                       ← 前端资源（打包进 APK 的就是这里）
│   ├── index.html             demo 入口（改了 title，挂上 camera.js / diag.js）
│   ├── camera.js              相机 / 相册 / 文件选择的取景器与面板
│   ├── diag.js                诊断浮层（顶栏问号 → iframe 打开 diag.html）
│   ├── diag.html              诊断页（版本 / 网络 / 存储 / 历史导入）
│   ├── zipcheck.html          ZIP 结构检查页
│   ├── LICENSE                DeepSeek chat-demo 的 MIT 原文
│   └── static/                demo 构建产物（第三方产物，仅改过 appName 与一处校验）
├── native-shell/              ← 主构建路径：免 Gradle，aapt + javac + d8
│   ├── src/app/dchat/MainActivity.java
│   ├── res/                   图标（各密度 + 自适应）
│   ├── icon-source.png        图标源文件（黑色 D）
│   ├── AndroidManifest.xml
│   └── build.sh
├── docs/
│   ├── BUILD.md               构建与签名
│   └── INTERNALS.md           实现细节与排障
├── frontend/                  chat-demo 前端源码（含改动）
├── server/proxy.mjs           本地静态预览服务（零依赖，只服务 www/）
├── third_party/chat-demo/     DeepSeek chat-demo 的 MIT 许可证
├── dist/                      构建产物（.gitignore 已排除）
├── LICENSE / NOTICE           本项目许可证 / 非官方声明与第三方组件
└── capacitor.config.json     仅在用 npx cap add android 生成原生工程时使用
```

## 更新日志

只列能感觉到的变化，细项见 [BUILD-NOTES.md](BUILD-NOTES.md)。

| 版本 | 变化 |
|---|---|
| 1.32 | 拍照后不写字也能直接发送；预览页 `+` / 语音 / 发送三键并排 |
| 1.31 | 英文系统首次启动也用英文；发图后的自动发送更快 |
| 1.30 | 拍照后的整套界面（取景器、预览、裁剪、提示）跟随中英语言 |
| 1.29 | 修复英文界面下发图卡住、开关点不动 |
| 1.28 | 清理无人使用的代码，输入区收尾 |

## 前端源码

`frontend/` 是完整的 chat-demo 源码（含本项目改动），`www/` 是它的构建产物：

```bash
cd frontend && pnpm install && pnpm build
rm -rf ../www && cp -r dist ../www
cd ../native-shell && bash build.sh
```

基线提交、改动清单见 [frontend/README.md](frontend/README.md)。

## 文档

| 文件 | 内容 |
|---|---|
| [docs/BUILD.md](docs/BUILD.md) | 本地预览、出包与签名、改配置、想用 Android Studio |
| [docs/INTERNALS.md](docs/INTERNALS.md) | 相机与附件链路、数量限制、历史导入、白屏排查 |

## License

MIT。上游 chat-demo 的 MIT 原文见 `third_party/chat-demo/LICENSE`，同一份也随 APK 打进 `assets/public/LICENSE`。
