# 构建与签名

## 本地先跑

```bash
cd chat-demo-app
npm run serve        # http://127.0.0.1:8080
```

浏览器开 `http://127.0.0.1:8080/`，能用就说明页面本身没问题，剩下只是套壳。

## 出 APK（Gradle 路径）

需要 JDK 17 + Android SDK（compileSdk 36），在**电脑**上做。

**Android Studio**：打开 `android/` → Build → Build APK(s)。

**命令行**：

```bash
npm run sync
cd android
./gradlew assembleDebug
# 产物 android/app/build/outputs/apk/debug/app-debug.apk
```

装到手机：`adb install -r app-debug.apk`，或把 APK 传过去点安装。

### 发布版签名

签名配置读 `android/keystore.properties`，这个文件**不提交**。第一次用：

```bash
cp android/keystore.properties.example android/keystore.properties
# 填 storeFile / storePassword / keyAlias / keyPassword
```

`storeFile` 相对路径以 `android/` 为基准，例如想复用自建壳那把密钥：

```properties
storeFile=../native-shell/release.jks
storePassword=你的密码
keyAlias=app
keyPassword=你的密码
```

然后：

```bash
cd android && ./gradlew assembleRelease
# 产物 android/app/build/outputs/apk/release/app-release.apk
```

**没有 `keystore.properties` 时会自动回退到 debug 签名** —— 别人 clone 下来不改任何东西也能出包。

> ⚠️ 两条构建路径的签名必须一致才能互相覆盖安装。
> 自建壳（`native-shell/build.sh`）用 `native-shell/release.jks`；
> 想让 Gradle 版覆盖它，`storeFile` 就指向同一把密钥，否则只能先卸载。

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

## 在手机上直接出包

不需要电脑、不需要 Gradle，全部工具在 aarch64 上可用。

| 步骤 | 工具 | 说明 |
|---|---|---|
| 编译 | `javac` 17 | 纯 framework 壳，不依赖 AndroidX |
| dex | `d8`（r8.jar） | Java 写的字节码工具，跨架构 |
| 资源打包 | `aapt`（Ubuntu 包） | **必须用 API 29 的 android.jar**，API 36 的资源表老 aapt 读不了 |
| 对齐 | `zipalign` | aarch64 可用 |
| 签名 | `apksigner`（Java） | 自签，首次安装需允许未知来源 |

重建：

```bash
cd native-shell
SDK=/root/sdk WWW=../www ./build.sh
# 产物：native-shell/dist/dchat-v1.apk
```

`native-shell/` 里是完整源码：

- `src/app/dchat/MainActivity.java` —— WebView 壳（`shouldInterceptRequest` 把 `https://localhost/**` 映射到 `assets/public/**`，含文件选择、系统相机兜底、相机权限授予）
- `AndroidManifest.xml` —— 权限、`queries`、targetSdk 36
- `res/` —— 图标资源：黑色大写 D（`icon-source.png` 为源图）+ 5 个密度 PNG + 圆形版 + 自适应图标前景
- `build.sh` —— 上面那条链的脚本

### 和 Capacitor 工程的关系

两套等价，选一套用：

- `android/` + Gradle：标准的 Capacitor 工程，功能全，但需要电脑和 Android Studio
- `native-shell/`：约 670 行的精简壳，能在手机上直接出包，体积更小（约 1.9MB vs Gradle 版通常 5MB+）

两者都从 `www/` 取资源，所以改页面只改一处，重跑对应构建即可。
