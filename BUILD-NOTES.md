# Dchat 重打包约定

本目录是 `kongbai884812/Dchat` 的本地工作副本；`www/` 来自 `../chat-demo-src/dist`（DeepSeek chat-demo 源码分支 `dchat`），不再改打包产物。

## 每次重建

```bash
cd ../chat-demo-src && pnpm build
rm -rf www && cp -r ../chat-demo-src/dist www
bash native-shell/build.sh          # → native-shell/dist/dchat-v1.apk
```

改过功能就同时升版本：`../chat-demo-src/package.json` 的 `version`、`native-shell/AndroidManifest.xml` 的 `versionCode` / `versionName`（同一 keystore，可覆盖安装上一版）。

## 产物投放

- 目录固定为手机 `/sdcard/Download/DSHA/`
- 文件名 `Dchat-v<version>-rebuild.apk`
- **只保留最新一个**：投放前先删掉同目录下旧的 `Dchat-*-rebuild.apk`
- 投放后核对 `sha256sum`，确保传输完整

```bash
cp native-shell/dist/dchat-v1.apk /tmp/Dchat-v<version>-rebuild.apk
/root/dsh-bin/adb-shell "rm -f /sdcard/Download/DSHA/Dchat-*-rebuild.apk"
curl -s -G 127.0.0.1:3090/app/export \
  --data-urlencode "path=/tmp/Dchat-v<version>-rebuild.apk" \
  -H @/root/.dsh/.bridge_headers
```

## 注意

- 官方商店/GitHub Release 的包签名不同，覆盖安装会失败；装重打包版需先卸载官方版（本地会话与 API Key 会清空，先导出历史）。
- 我们自己前后两版 keystore 相同，可直接覆盖升级。
- API Key 由 `DchatSecure` 桥（Android Keystore AES-GCM）加密后存 SharedPreferences，明文不再落 localStorage。