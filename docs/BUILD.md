# 构建与签名

## 本地先跑

```bash
cd chat-demo-app
npm run serve        # http://127.0.0.1:8080，只是把 www/ 当静态站点跑
```

浏览器开 `http://127.0.0.1:8080/`，能用就说明页面本身没问题，剩下只是套壳。

## 出 APK（唯一路径：native-shell）

不需要电脑、不需要 Gradle，aarch64 上全部工具都可用，直接在手机/容器里出包：

```bash
cd native-shell
SDK=/root/sdk WWW=../www ./build.sh
# 产物：native-shell/dist/dchat-v1.apk
```

依赖：`aapt`、`zipalign`、`apksigner`（apt），JDK 17，`android-36/android.jar`（javac + d8），
`android-29/android-10/android.jar`（aapt 用，旧资源表），`r8.jar`（提供 d8）。

| 步骤 | 工具 | 说明 |
|---|---|---|
| 编译 | `javac` 17 | 纯 framework 壳，不依赖 AndroidX |
| dex | `d8`（r8.jar） | Java 写的字节码工具，跨架构 |
| 资源打包 | `aapt` | **必须用 API 29 的 android.jar**，API 36 的资源表老 aapt 读不了 |
| 对齐 | `zipalign` | aarch64 可用 |
| 签名 | `apksigner`（Java） | 自签，首次安装需允许未知来源 |

签名证书 `native-shell/release.jks` 由 `build.sh` 首次运行时生成，之后一直复用，所以能覆盖安装、数据不丢。
想换密码：`KS_PASS=你的密码 ./build.sh`。

`native-shell/` 里是完整源码：

- `src/app/dchat/MainActivity.java` —— WebView 壳（`shouldInterceptRequest` 把 `https://localhost/**` 映射到 `assets/public/**`，含文件选择、系统相机兜底、相机/录音权限授予、ZIP 精简导入）
- `AndroidManifest.xml` —— 权限、`queries`、targetSdk 36
- `res/` —— 图标资源：黑色大写 D（`icon-source.png` 为源图）+ 5 个密度 PNG + 圆形版 + 自适应图标前景
- `build.sh` —— 上面那条链的脚本

### 想在电脑上用 Android Studio？

仓库里**不再提交** Capacitor 的原生工程（避免两套构建路径各自漂移）。需要时现场生成：

```bash
npm install
npx cap add android            # 按 capacitor.config.json 生成 android/
cp native-shell/src/app/dchat/MainActivity.java android/app/src/main/java/app/dchat/
npx cap sync android
cd android && ./gradlew assembleRelease
```

注意两点：生成出来的壳要手动换成上面那份 `MainActivity.java`（Capacitor 默认的是 `BridgeActivity`）；
签名想和 `native-shell` 版互相覆盖安装，需指向同一把 `native-shell/release.jks`。

## 改配置

`capacitor.config.json`：

```json
{
  "appId": "app.dchat",
  "appName": "Dchat",
  "webDir": "www",
  "server": { "androidScheme": "https", "cleartext": false },
  "android": { "allowMixedContent": false, "webContentsDebuggingEnabled": true }
}
```

`webContentsDebuggingEnabled` 已开：数据线连电脑，Chrome 打开 `chrome://inspect` 能直接看 App 内 WebView 的 console。
