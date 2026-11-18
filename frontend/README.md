# 前端源码（chat-demo 派生）

Dchat 的界面就是这一套网页，构建产物放进 `../www/`，再由 `native-shell/build.sh` 打进 APK。

- 上游：[deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo)（MIT，许可证见本目录 `LICENSE`）
- 基线提交：`5d5dd75`（"fix: clarify history import errors and release v0.1.1"）
- 本目录 = 上游源码 + 下方列出的改动，可直接 `pnpm install && pnpm build`

## 构建

```bash
pnpm install
pnpm build              # 输出 dist/
rm -rf ../www && cp -r dist ../www
cd ../native-shell && bash build.sh
```

## 相对上游的改动

共 51 个文件、约 +3925 / −897 行，集中在：

| 文件 | 改动 |
|---|---|
| `src/components/chat/ChatInput.tsx` | 输入区重做：附件「+」在卡片内展开、加号旋转成叉、右下角三合一按钮 |
| `src/components/chat/HoldToTalk.tsx`（新增） | 「按住 说话」按钮：按下收音、松手发送、上滑取消 |
| `src/hooks/usePushToTalk.ts`（新增） | 录音 → 上传 `/v1/tools/asr` → 回填/直接发送的完整状态机 |
| `src/services/speech/recorder.ts`、`trace.ts` | 麦克风三档降级、预热、诊断日志 |
| `src/services/settings.ts` | API Key 走 Android Keystore 加密（`DchatSecure` 桥），余额查询、语言读写 |
| `src/services/balance.ts`、`components/settings/BalancePanel.tsx`（新增） | 余额面板 |
| `src/i18n/zh.ts`、`en.ts` | 新增文案（发送/深度思考/搜索/按住说话/诊断等） |
| `src/index.html` | 挂 `camera.js`、`diag.js` 两个壳补丁脚本 |
| 删除 | 上游 demo 遗留的 `VoiceButton`、`useVoiceInput`、`Spectrum` |

`public/camera.js`（相机、预览页、裁剪、i18n）与 `public/diag.js`（诊断页）是壳层补丁，
在 `../www/` 里保持同一份，改动时两边要同步。
