# Dchat 重打包约定

本目录是 `kongbai884812/Dchat` 的本地工作副本；`www/` 来自 `../chat-demo-src/dist`（DeepSeek chat-demo 源码分支 `dchat`），不再改打包产物。

## 每次重建

```bash
cd ../chat-demo-src && pnpm build
rm -rf www && cp -r ../chat-demo-src/dist www
bash native-shell/build.sh          # → native-shell/dist/dchat-v1.apk
```

改过功能就同时升版本：`../chat-demo-src/package.json` 的 `version`、`native-shell/AndroidManifest.xml` 的 `versionCode` / `versionName`（同一 keystore，可覆盖安装上一版）。

构建路径只有 `native-shell/` 一条（原来的 Capacitor/Gradle 工程已从仓库移除，需要时用 `npx cap add android` 现场生成，见 `docs/BUILD.md`）。版本号只需改两处：`../chat-demo-src/package.json` 和 `native-shell/AndroidManifest.xml`。

## 产物投放

- 目录固定为手机 `/sdcard/Download/DSHA/`
- 文件名 `Dchat.apk`（不带版本号，避免安装包名字里出现版本）
- **只保留最新一个**：投放前先删掉同目录下的旧文件
- 投放后核对 `sha256sum`，确保传输完整

```bash
cp native-shell/dist/dchat-v1.apk /tmp/Dchat.apk
# 设备策略禁止通配符，必须逐个写明确路径
/root/dsh-bin/adb-shell "rm -f /sdcard/Download/DSHA/Dchat-v1.28-rebuild.apk"
curl -s -G 127.0.0.1:3090/app/export \
  --data-urlencode "path=/tmp/Dchat.apk" \
  -H @/root/.dsh/.bridge_headers
```

## 本轮功能（1.32）

- 预览页按钮拆开：`+` / 麦克风（切语音变键盘）/ 发送箭头三个 30px 小圆钮并排，一行放得下，不超出输入卡片
- 修复：拍完照不写字就发不出去（三合一那时没文字就是麦克风，点它只会切语音）
- 药丸收窄（padding 6×9、字号 12px），中英文标签都不会撑破一行
- 删掉随之失效的 `act === 'mic'` 分支与 `voiceInChat` 文案

## 上一轮功能（1.31）

- 首次启动且系统是英文时，相机界面也走英文（之前没有 `chat-demo:locale` 就默认中文，和 App 不一致）
- `autoSend()` 从 80×200ms 轮询改成 `MutationObserver`：按钮一出现就点，最快，也不再空转
- `LABELS` 里「发送/深度思考/智能搜索」改为从 `I18N` 派生，改文案不用改两处
- 删掉无人调用的 `Bridge.pickZip()`（约 14 行）及其悬空注解；`LABELS.upload` 改由点击过渡复用

## 上一轮功能（1.30）

- 拍照后的整套 UI（取景器标题、预览页、裁剪页、按住说话、快捷提问、各种 toast）跟随 App 语言，英文界面下不再显示中文
- `camera.js` 自带 `I18N` 词典（当时 49 个键 × 2 语言，1.32 去掉 `voiceInChat` 后 48）+ `t()`，现读 `localStorage['chat-demo:locale']`；语言变化后预览页会重建

## 上一轮功能（1.29）

- 修复：英文界面下「发送」按钮找不到（`camera.js` 写死中文 `aria-label`），预览页发图会卡住；深度思考 / 智能搜索开关、侧边栏热区同样受影响
- 做法：`camera.js` 顶部加 `LABELS` 双语表和 `byLabel()`，所有跨到聊天页的选择器统一走它

## 更早：1.28

- 语音输入：`HoldToTalk` + `usePushToTalk`，按住收音、松手转写即发送、上滑取消；接口 `/v1/tools/asr`
- 录音链路：三档约束退让 + 记住可用档位 + 进入语音模式预热麦克风（`warmStream` 直接复用）
- 输入框：附件「+」在卡片内展开（拍照/相册/文件），加号旋转成叉；右下角三合一按钮（发送/麦克风/键盘）
- 拍照预览页：左上退出、右上裁剪、快捷提问，输入框复用主界面同一套三合一与按住说话（经 `window.__voice*` 钩子）
- 清理：删除 demo 遗留的 `VoiceButton` / `useVoiceInput` / `Spectrum`，去掉 `diag.js` 里的界面自检探针

## 注意

- 官方商店/GitHub Release 的包签名不同，覆盖安装会失败；装重打包版需先卸载官方版（本地会话与 API Key 会清空，先导出历史）。
- 我们自己前后两版 keystore 相同，可直接覆盖升级。
- API Key 由 `DchatSecure` 桥（Android Keystore AES-GCM）加密后存 SharedPreferences，明文不再落 localStorage。