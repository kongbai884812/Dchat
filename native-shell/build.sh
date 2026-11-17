#!/usr/bin/env bash
# 在 aarch64 Linux 上直接构建 WebView 壳 APK（不用 Gradle / Android Studio）
#
# 依赖：aapt、zipalign、apksigner（Ubuntu: apt install aapt zipalign apksigner）
#       JDK 17、android-36 的 android.jar（javac/d8 用）
#       android-29 的 android.jar（aapt 用，新版资源表老 aapt 读不了）
#       r8.jar（d8）
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SDK="${SDK:-/root/sdk}"
JAR_BUILD="$SDK/android-36/android.jar"     # javac + d8
JAR_AAPT="$SDK/android-29/android-10/android.jar"  # aapt（旧资源表）
R8="$SDK/r8.jar"
WWW="${WWW:-$HERE/../www}"
OUT="$HERE/build"
KS="$HERE/release.jks"
# 自签名密码：默认值只够本地自测，发布请自己设 KS_PASS
KS_PASS="${KS_PASS:-local-dev-only}"

echo "== 1/7 清理"
rm -rf "$OUT" && mkdir -p "$OUT/classes" "$OUT/dex" "$OUT/assets/public"

echo "== 2/7 拷贝网页资源"
cp -r "$WWW"/. "$OUT/assets/public/"

if [ "${WITH_DIAG:-1}" = "0" ]; then
  echo "== 2.5/7 移除诊断入口（发布版）"
  python3 - "$OUT/assets/public/index.html" <<'PYEOF'
import re, sys
p = sys.argv[1]
s = open(p, encoding="utf-8").read()
s = re.sub(r"<!-- DIAG-START -->.*?<!-- DIAG-END -->\n?", "", s, flags=re.S)
open(p, "w", encoding="utf-8").write(s)
PYEOF
fi

echo "== 3/7 编译 Java"
JAVAC_LOG="$OUT/javac.log"
if ! javac -encoding UTF-8 -source 8 -target 8 \
    -classpath "$JAR_BUILD" \
    -d "$OUT/classes" \
    $(find "$HERE/src" -name "*.java") 2>"$JAVAC_LOG"; then
  grep -v "bootstrap class path" "$JAVAC_LOG" >&2 || true
  echo "编译失败" >&2
  exit 1
fi
grep -v "bootstrap class path" "$JAVAC_LOG" || true

echo "== 4/7 生成 dex"
java -cp "$R8" com.android.tools.r8.D8 --release --min-api 24 \
  --lib "$JAR_BUILD" --output "$OUT/dex" \
  $(find "$OUT/classes" -name "*.class")

echo "== 5/7 aapt 打包（manifest + assets）"
aapt package -f \
  -M "$HERE/AndroidManifest.xml" \
  -A "$OUT/assets" \
  -S "$HERE/res" \
  -I "$JAR_AAPT" \
  -F "$OUT/app.unsigned.apk"

echo "== 6/7 加入 classes.dex + 对齐"
(cd "$OUT/dex" && aapt add ../app.unsigned.apk classes.dex >/dev/null)
zipalign -f -p 4 "$OUT/app.unsigned.apk" "$OUT/app.aligned.apk"

echo "== 7/7 签名"
if [ ! -f "$KS" ]; then
  keytool -genkeypair -v -keystore "$KS" -alias app -keyalg RSA -keysize 2048 \
    -validity 10000 -storepass "$KS_PASS" -keypass "$KS_PASS" \
    -dname "CN=ChatDemo, OU=Demo, O=Demo, L=CN, ST=C, C=CN" >/dev/null 2>&1
fi
mkdir -p "$HERE/dist"
# v1 (JAR) 签名必须开：华为/荣耀的应用检测是按 v1 摘要去查的，
# 只有 v2/v3 时系统"认不出"签名方，会报「身份未经核实」。
apksigner sign --ks "$KS" --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" \
  --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true \
  --min-sdk-version 24 \
  --out "$HERE/dist/dchat-v1.apk" "$OUT/app.aligned.apk"

echo
echo "完成: $HERE/dist/dchat-v1.apk"
ls -lh "$HERE/dist/dchat-v1.apk"
aapt dump badging "$HERE/dist/dchat-v1.apk" 2>/dev/null | head -3
