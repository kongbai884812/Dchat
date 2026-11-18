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

## 本轮功能（1.28）

- 语音输入：`HoldToTalk` + `usePushToTalk`，按住收音、松手转写即发送、上滑取消；接口 `/v1/tools/asr`
- 录音链路：三档约束退让 + 记住可用档位 + 进入语音模式预热麦克风（`warmStream` 直接复用）
- 输入框：附件「+」在卡片内展开（拍照/相册/文件），加号旋转成叉；右下角三合一按钮（发送/麦克风/键盘）
- 拍照预览页：左上退出、右上裁剪、快捷提问，输入框复用主界面同一套三合一与按住说话（经 `window.__voice*` 钩子）
- 清理：删除 demo 遗留的 `VoiceButton` / `useVoiceInput` / `Spectrum`，去掉 `diag.js` 里的界面自检探针

## 注意

- 官方商店/GitHub Release 的包签名不同，覆盖安装会失败；装重打包版需先卸载官方版（本地会话与 API Key 会清空，先导出历史）。
- 我们自己前后两版 keystore 相同，可直接覆盖升级。
- API Key 由 `DchatSecure` 桥（Android Keystore AES-GCM）加密后存 SharedPreferences，明文不再落 localStorage。