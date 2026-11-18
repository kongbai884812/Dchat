package app.dchat;

import android.Manifest;
import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.util.Base64;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.widget.FrameLayout;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * 极简 WebView 壳：把 assets/public 通过 https://localhost 提供给页面。
 *
 * 为什么不用 file://：分包 import()、IndexedDB、fetch 都会因非安全上下文/跨域失败，
 * 表现为白屏。https://localhost 是安全上下文，等同于正常网站。
 *
 * 不依赖 AndroidX / Gradle，只用 framework API，方便在 aarch64 上用 aapt+d8 直接出包。
 */
public class MainActivity extends Activity {

    private static final boolean DEBUG = false;
    private static final String HOST = "localhost";
    private static final String START_URL = "https://localhost/index.html";
    private static final int REQ_FILES = 2001;
    private static final int REQ_CAMERA_PERM = 2002;
    private static final int REQ_ZIP = 2003;

    private WebView web;
    private ValueCallback<Uri[]> pendingFiles;
    private PermissionRequest pendingPermission;
    private Uri cameraOutput;
    private File slimFile;
    private long slimSize;
    private boolean modalOpen;
    private android.window.OnBackInvokedCallback backCallback;

    private static final Map<String, String> MIME = new HashMap<String, String>();

    static {
        MIME.put("html", "text/html");
        MIME.put("htm", "text/html");
        MIME.put("js", "text/javascript");
        MIME.put("mjs", "text/javascript");
        MIME.put("css", "text/css");
        MIME.put("json", "application/json");
        MIME.put("map", "application/json");
        MIME.put("svg", "image/svg+xml");
        MIME.put("png", "image/png");
        MIME.put("jpg", "image/jpeg");
        MIME.put("jpeg", "image/jpeg");
        MIME.put("gif", "image/gif");
        MIME.put("webp", "image/webp");
        MIME.put("ico", "image/x-icon");
        MIME.put("woff", "font/woff");
        MIME.put("woff2", "font/woff2");
        MIME.put("ttf", "font/ttf");
        MIME.put("otf", "font/otf");
        MIME.put("txt", "text/plain");
        MIME.put("wasm", "application/wasm");
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);   // 文件选择器返回的是 content:// URI，必须放行
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        }

        web.setWebViewClient(new AssetClient());
        web.setWebChromeClient(new Chrome());
        web.addJavascriptInterface(new Bridge(), "NativeShell");
        web.addJavascriptInterface(new SecureBridge(), "DchatSecure");

        web.setDownloadListener(new android.webkit.DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                        String mimetype, long contentLength) {
                if (url != null && url.startsWith("blob:")) {
                    // WebView 不能直接下 blob，让页面把内容切成 base64 分片递过来
                    String js =
                        "(function(){var u=" + org.json.JSONObject.quote(url) + ";" +
                        "fetch(u).then(function(r){return r.arrayBuffer();}).then(function(buf){" +
                        "  var u8=new Uint8Array(buf);var CH=384*1024;" +
                        "  NativeShell.beginDownload('dchat-history.zip', u8.length);" +
                        "  for(var i=0,j=0;i<u8.length;i+=CH,j++){" +
                        "    var part=u8.subarray(i,Math.min(i+CH,u8.length));var s='';" +
                        "    for(var k=0;k<part.length;k+=8192){" +
                        "      s+=String.fromCharCode.apply(null,part.subarray(k,Math.min(k+8192,part.length)));" +
                        "    }" +
                        "    NativeShell.writeChunk(j,btoa(s));" +
                        "  }" +
                        "  NativeShell.endDownload();" +
                        "}).catch(function(e){NativeShell.downloadFailed(String(e));});})();";
                    web.evaluateJavascript(js, null);
                }
            }
        });

        FrameLayout root = new FrameLayout(this);
        root.addView(web, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);

        // 键盘 / 挖孔避让：挂在根布局上，padding 会真正缩小 WebView 的可用区域，
        // 页面随之重排，输入框才会落在键盘上方。
        root.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            @Override
            public WindowInsets onApplyWindowInsets(View v, WindowInsets insets) {
                int top = 0, ime = 0;
                if (Build.VERSION.SDK_INT >= 30) {
                    top = insets.getInsets(WindowInsets.Type.displayCutout()).top;
                    ime = insets.getInsets(WindowInsets.Type.ime()).bottom;
                } else if (Build.VERSION.SDK_INT >= 28) {
                    android.view.DisplayCutout cut = insets.getDisplayCutout();
                    if (cut != null) top = cut.getSafeInsetTop();
                }
                if (v.getPaddingTop() != top || v.getPaddingBottom() != ime) {
                    v.setPadding(0, top, 0, ime);
                }
                return insets;
            }
        });

        web.loadUrl(START_URL);

        // Android 13+ 启用了预测性返回手势后，onBackPressed 不再触发，
        // 这里显式注册回调；33 以下仍走 onBackPressed。
        if (Build.VERSION.SDK_INT >= 33) {
            try {
                backCallback = new android.window.OnBackInvokedCallback() {
                    @Override
                    public void onBackInvoked() {
                        handleBack();
                    }
                };
                getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                        android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, backCallback);
            } catch (Throwable ignored) {
                backCallback = null;
            }
        }
    }

    private void handleBack() {
        // 有浮层（相机 / 诊断页）先关浮层，别直接退出应用
        if (modalOpen && web != null) {
            modalOpen = false;
            web.evaluateJavascript(
                "(function(){try{if(window.__closeDiag)window.__closeDiag();}catch(e){}" +
                "try{if(window.__closeCam)window.__closeCam();}catch(e){}})()", null);
            return;
        }
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        finish();
    }

    /** 把 https://localhost/** 映射到 assets/public/** */
    private class AssetClient extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (uri == null) return null;
            String host = uri.getHost();
            if (host == null || !host.equalsIgnoreCase(HOST)) return null;

            String path = uri.getPath();
            if (path == null || path.length() == 0 || "/".equals(path)) path = "/index.html";

            String asset = "public" + path;
            try {
                InputStream in = getAssets().open(asset);
                String ext = "";
                int dot = path.lastIndexOf('.');
                if (dot >= 0) ext = path.substring(dot + 1).toLowerCase();
                String mime = MIME.containsKey(ext) ? MIME.get(ext) : "application/octet-stream";
                boolean textLike = mime.startsWith("text/")
                        || mime.contains("json") || mime.contains("javascript") || mime.contains("svg");
                return new WebResourceResponse(mime, textLike ? "utf-8" : null, in);
            } catch (IOException e) {
                return new WebResourceResponse(
                        "text/plain", "utf-8", 404, "Not Found",
                        new HashMap<String, String>(),
                        new ByteArrayInputStream(("404 " + path).getBytes()));
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            if (u == null) return false;
            if (HOST.equalsIgnoreCase(u.getHost())) return false;
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, u));
            } catch (Exception ignored) {
            }
            return true;
        }
    }

    private class Chrome extends WebChromeClient {
        @Override
        public boolean onConsoleMessage(android.webkit.ConsoleMessage cm) {
            // 页面 console 输出转发到 logcat，方便排查界面问题
            android.util.Log.i("DchatWeb", cm.message() + " (" + cm.sourceId() + ":" + cm.lineNumber() + ")");
            return true;
        }

        @Override
        public void onPermissionRequest(final PermissionRequest request) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    boolean wantsCamera = false;
                    boolean wantsAudio = false;
                    for (String r : request.getResources()) {
                        if ("android.webkit.resource.VIDEO_CAPTURE".equals(r)) wantsCamera = true;
                        if ("android.webkit.resource.AUDIO_CAPTURE".equals(r)) wantsAudio = true;
                    }
                    // 缺哪个系统权限就先申请，一次把缺的都申请掉
                    java.util.ArrayList<String> missing = new java.util.ArrayList<>();
                    if (wantsCamera
                            && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                        missing.add(Manifest.permission.CAMERA);
                    }
                    if (wantsAudio
                            && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                        missing.add(Manifest.permission.RECORD_AUDIO);
                    }
                    if (!missing.isEmpty()) {
                        pendingPermission = request;
                        requestPermissions(missing.toArray(new String[0]), REQ_CAMERA_PERM);
                        return;
                    }
                    request.grant(request.getResources());
                }
            });
        }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                         FileChooserParams params) {
            if (pendingFiles != null) {
                pendingFiles.onReceiveValue(null);
                pendingFiles = null;
            }
            pendingFiles = callback;

            String[] accept = params.getAcceptTypes();
            boolean imageOnly = false;
            if (accept != null) {
                for (String a : accept) {
                    if (a != null && a.toLowerCase().contains("image")) imageOnly = true;
                }
            }
            boolean capture = params.isCaptureEnabled();

            boolean zipPick = false;
            if (accept != null) {
                for (String a : accept) {
                    if (a != null && a.toLowerCase().contains("zip")) zipPick = true;
                }
            }

            try {
                if (zipPick) {
                    // 让 WebView 认为用户取消了，避免它的回调一直悬着
                    callback.onReceiveValue(null);
                    pendingFiles = null;
                    openZipPicker();
                    return true;
                }
                if (capture && imageOnly) {
                    Intent take = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
                    cameraOutput = createImageUri();
                    if (cameraOutput != null && take.resolveActivity(getPackageManager()) != null) {
                        take.putExtra(MediaStore.EXTRA_OUTPUT, cameraOutput);
                        startActivityForResult(take, REQ_FILES);
                        return true;
                    }
                }
                boolean multiple = params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE;

                // 图片走系统照片选择器（和 DeepSeek App 一致），不是文件管理器
                if (imageOnly && Build.VERSION.SDK_INT >= 33) {
                    try {
                        Intent pick = new Intent(MediaStore.ACTION_PICK_IMAGES);
                        pick.setType("image/*");
                        if (multiple) {
                            pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                            pick.putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, pickImagesMax());
                        }
                        startActivityForResult(pick, REQ_FILES);
                        return true;
                    } catch (Exception ignored) {
                        // 超过机型上限会抛异常、选择器直接不弹；落到下面的文档选择器兜底
                    }
                }

                Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                pick.setType(imageOnly ? "image/*" : "*/*");
                if (multiple) {
                    pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                }
                startActivityForResult(pick, REQ_FILES);
                return true;
            } catch (Exception e) {
                pendingFiles = null;
                if (callback != null) callback.onReceiveValue(null);
                return false;
            }
        }
    }

    /**
     * 照片选择器的上限必须 <= MediaStore.getPickImagesMaxLimit()，
     * 超过会抛 IllegalArgumentException，表现为"点了没反应"。
     */
    private static int pickImagesMax() {
        try {
            int limit = MediaStore.getPickImagesMaxLimit();
            return Math.max(1, Math.min(200, limit));
        } catch (Throwable t) {
            return 50;
        }
    }

    private Uri createImageUri() {
        try {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Images.Media.DISPLAY_NAME,
                    "cam_" + System.currentTimeMillis() + ".jpg");
            values.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
            return getContentResolver()
                    .insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
        } catch (Exception e) {
            return null;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_ZIP) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                slimArchive(data.getData());
            }
            return;
        }
        if (requestCode == REQ_FILES) {
            // 用户取消拍照时，之前插入的 MediaStore 空记录要删掉，否则相册里多一张 0 字节图
            if (resultCode != RESULT_OK && cameraOutput != null) {
                try { getContentResolver().delete(cameraOutput, null, null); } catch (Exception ignored) {}
            }
            Uri[] result = null;
            if (resultCode == RESULT_OK) {
                if (data != null && data.getClipData() != null) {
                    int n = data.getClipData().getItemCount();
                    result = new Uri[n];
                    for (int i = 0; i < n; i++) {
                        result[i] = data.getClipData().getItemAt(i).getUri();
                    }
                } else if (data != null && data.getData() != null) {
                    result = new Uri[]{data.getData()};
                } else if (cameraOutput != null) {
                    result = new Uri[]{cameraOutput};
                }
            }
            if (pendingFiles != null) {
                pendingFiles.onReceiveValue(result);
                pendingFiles = null;
            }
            cameraOutput = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode == REQ_CAMERA_PERM) {
            if (pendingPermission != null) {
                boolean ok = grantResults.length > 0;
                for (int result : grantResults) {
                    if (result != PackageManager.PERMISSION_GRANTED) ok = false;
                }
                if (ok) pendingPermission.grant(pendingPermission.getResources());
                else pendingPermission.deny();
                pendingPermission = null;
            }
        }
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    }

    /**
     * API Key 加密存储：Android Keystore 里的 AES-256 密钥（不可导出）+ AES/GCM 密文。
     * 网页拿到的仍是明文，但落盘、云备份、adb pull 出来的都只是密文。
     */
    public class SecureBridge {
        private static final String PREF = "dchat-secure";
        private static final String ALIAS = "dchat-api-key";
        private static final String FIELD = "api-key";

        private javax.crypto.SecretKey secretKey() throws Exception {
            java.security.KeyStore ks = java.security.KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            if (ks.containsAlias(ALIAS)) {
                return ((java.security.KeyStore.SecretKeyEntry) ks.getEntry(ALIAS, null)).getSecretKey();
            }
            javax.crypto.KeyGenerator kg =
                    javax.crypto.KeyGenerator.getInstance("AES", "AndroidKeyStore");
            kg.init(new android.security.keystore.KeyGenParameterSpec.Builder(
                    ALIAS,
                    android.security.keystore.KeyProperties.PURPOSE_ENCRYPT
                            | android.security.keystore.KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(android.security.keystore.KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(android.security.keystore.KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build());
            return kg.generateKey();
        }

        @android.webkit.JavascriptInterface
        public String getKey() {
            String stored = getSharedPreferences(PREF, MODE_PRIVATE).getString(FIELD, null);
            if (stored == null) {
                return null;
            }
            try {
                byte[] raw = android.util.Base64.decode(stored, android.util.Base64.NO_WRAP);
                byte[] iv = java.util.Arrays.copyOfRange(raw, 0, 12);
                byte[] body = java.util.Arrays.copyOfRange(raw, 12, raw.length);
                javax.crypto.Cipher cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(javax.crypto.Cipher.DECRYPT_MODE, secretKey(),
                        new javax.crypto.spec.GCMParameterSpec(128, iv));
                return new String(cipher.doFinal(body), java.nio.charset.StandardCharsets.UTF_8);
            } catch (Exception e) {
                // 密钥失效（系统重置、备份恢复）时清掉密文，让用户重新填
                clearKey();
                return null;
            }
        }

        @android.webkit.JavascriptInterface
        public void setKey(String value) {
            if (value == null) {
                clearKey();
                return;
            }
            try {
                javax.crypto.Cipher cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(javax.crypto.Cipher.ENCRYPT_MODE, secretKey());
                byte[] body = cipher.doFinal(value.getBytes(java.nio.charset.StandardCharsets.UTF_8));
                byte[] iv = cipher.getIV();
                byte[] raw = new byte[iv.length + body.length];
                System.arraycopy(iv, 0, raw, 0, iv.length);
                System.arraycopy(body, 0, raw, iv.length, body.length);
                getSharedPreferences(PREF, MODE_PRIVATE).edit()
                        .putString(FIELD, android.util.Base64.encodeToString(raw, android.util.Base64.NO_WRAP))
                        .apply();
            } catch (Exception e) {
                // 加密失败就不落盘，网页下次会要求重填
            }
        }

        @android.webkit.JavascriptInterface
        public void clearKey() {
            getSharedPreferences(PREF, MODE_PRIVATE).edit().remove(FIELD).apply();
        }
    }

    /** 暴露给网页：精简导入 */
    public class Bridge {
        private java.io.RandomAccessFile dlRaf;
        private java.io.File dlFile;
        private long dlTotal;

        @JavascriptInterface
        public void beginDownload(String name, long total) {
            // name/total 目前只用于日志，文件名在 endDownload 里生成
            try {
                closeDl();
                dlFile = new File(getCacheDir(), "dl-tmp.bin");
                dlRaf = new java.io.RandomAccessFile(dlFile, "rw");
                dlRaf.setLength(0);
                dlTotal = total;
            } catch (Exception e) {
                dlRaf = null;
            }
        }

        @JavascriptInterface
        public void writeChunk(int index, String b64) {
            try {
                if (dlRaf == null) return;
                byte[] data = Base64.decode(b64, Base64.DEFAULT);
                dlRaf.write(data);
            } catch (Exception ignored) {
            }
        }

        @JavascriptInterface
        public void endDownload() {
            final File f = dlFile;
            try { closeDl(); } catch (Exception ignored) {}
            if (f == null || !f.exists()) return;
            final long size = f.length();
            runOnUiThread(new Runnable() {
                public void run() {
                    try {
                        ContentValues v = new ContentValues();
                        v.put(MediaStore.Downloads.DISPLAY_NAME,
                                "dchat-history-" + System.currentTimeMillis() + ".zip");
                        v.put(MediaStore.Downloads.MIME_TYPE, "application/zip");
                        android.net.Uri uri = getContentResolver()
                                .insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                        java.io.InputStream in = new java.io.FileInputStream(f);
                        java.io.OutputStream out = getContentResolver().openOutputStream(uri);
                        byte[] buf = new byte[64 * 1024];
                        int n;
                        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                        out.close();
                        in.close();
                        f.delete();
                        android.widget.Toast.makeText(MainActivity.this,
                                "已保存到「下载」目录（" + (size / 1024 / 1024) + "MB）",
                                android.widget.Toast.LENGTH_LONG).show();
                    } catch (Exception e) {
                        downloadFailedToUser(String.valueOf(e.getMessage()));
                    }
                }
            });
        }

        private void closeDl() {
            try { if (dlRaf != null) dlRaf.close(); } catch (Exception ignored) {}
            dlRaf = null;
        }

        @JavascriptInterface
        public void downloadFailed(String msg) {
            downloadFailedToUser(msg);
        }

        /**
         * 页面自检用：把一段文本写到「下载」目录，方便从外部读取（仅诊断使用）。
         */
        @JavascriptInterface
        public void dumpText(String name, String text) {
            try {
                // 先删掉同名旧文件，避免 MediaStore 自动加 (1)(2) 后缀
                try {
                    getContentResolver().delete(MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                            MediaStore.Downloads.DISPLAY_NAME + "=?", new String[]{name});
                } catch (Exception ignored) {
                }
                ContentValues v = new ContentValues();
                v.put(MediaStore.Downloads.DISPLAY_NAME, name);
                v.put(MediaStore.Downloads.MIME_TYPE, "text/plain");
                android.net.Uri uri = getContentResolver()
                        .insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (uri == null) return;
                java.io.OutputStream out = getContentResolver().openOutputStream(uri);
                out.write(text.getBytes("UTF-8"));
                out.close();
            } catch (Exception ignored) {
            }
        }

        @JavascriptInterface
        public void setModal(int v) {
            modalOpen = v == 1;
        }

        @JavascriptInterface
        public String readChunk(int offset, int len) {
            if (slimFile == null || offset < 0 || len <= 0) return "";
            RandomAccessFile raf = null;
            try {
                raf = new RandomAccessFile(slimFile, "r");
                raf.seek(offset);
                byte[] buf = new byte[Math.min(len, 4 * 1024 * 1024)];
                int n = raf.read(buf);
                if (n <= 0) return "";
                return Base64.encodeToString(buf, 0, n, Base64.NO_WRAP);
            } catch (Exception e) {
                return "";
            } finally {
                try { if (raf != null) raf.close(); } catch (Exception ignored) {}
            }
        }
    }

    private void downloadFailedToUser(final String msg) {
        runOnUiThread(new Runnable() {
            public void run() {
                android.widget.Toast.makeText(MainActivity.this,
                        "下载失败：" + msg, android.widget.Toast.LENGTH_LONG).show();
            }
        });
    }

    private void openZipPicker() {
        try {
            Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType("*/*");
            startActivityForResult(i, REQ_ZIP);
        } catch (Exception e) {
            notifySlim(-1);
        }
    }

    private void notifySlim(final long size) {
        runOnUiThread(new Runnable() {
            public void run() {
                if (web != null) {
                    web.evaluateJavascript(
                            "window.__slimReady&&window.__slimReady(" + size + ")", null);
                }
            }
        });
    }

    /**
     * 流式复制 ZIP，跳过 chat_sessions/xxx_files/ 下的附件。
     * 211MB 的包经过这里通常只剩几 MB，WebView 才吃得下。
     */
    private void slimArchive(final Uri uri) {
        new Thread(new Runnable() {
            public void run() {
                File out = new File(getCacheDir(), "slim-archive.zip");
                if (out.exists() && !out.delete()) {
                    // 删不掉就换个名字，避免续写到旧文件
                    out = new File(getCacheDir(), "slim-" + System.currentTimeMillis() + ".zip");
                }
                boolean ok = false;
                InputStream in = null;
                ZipInputStream zis = null;
                ZipOutputStream zos = null;
                try {
                    in = getContentResolver().openInputStream(uri);
                    if (in == null) { notifySlim(-1); return; }
                    zis = new ZipInputStream(new BufferedInputStream(in, 128 * 1024));
                    zos = new ZipOutputStream(new BufferedOutputStream(
                            new FileOutputStream(out), 128 * 1024));
                    byte[] buf = new byte[64 * 1024];
                    ZipEntry e;
                    while ((e = zis.getNextEntry()) != null) {
                        String name = e.getName();
                        if (name == null) continue;
                        if (name.indexOf("_files/") >= 0) {
                            zis.closeEntry();
                            continue;
                        }
                        zos.putNextEntry(new ZipEntry(name));
                        if (!e.isDirectory()) {
                            int n;
                            while ((n = zis.read(buf)) > 0) {
                                zos.write(buf, 0, n);
                            }
                        }
                        zos.closeEntry();
                        zis.closeEntry();
                    }
                    zos.finish();
                    ok = true;
                } catch (Exception ex) {
                    ok = false;
                } finally {
                    try { if (zos != null) zos.close(); } catch (Exception ignored) {}
                    try { if (zis != null) zis.close(); } catch (Exception ignored) {}
                    try { if (in != null) in.close(); } catch (Exception ignored) {}
                }
                if (ok) {
                    slimFile = out;
                    slimSize = out.length();
                    notifySlim(slimSize);
                } else {
                    notifySlim(-1);
                }
            }
        }).start();
    }

    @Override
    public void onBackPressed() {
        handleBack();
    }

    private void applyImmersive() {
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                Window w = getWindow();
                w.setDecorFitsSystemWindows(false);
                WindowInsetsController c = w.getInsetsController();
                if (c != null) {
                    c.hide(WindowInsets.Type.statusBars());   // 只隐藏状态栏，手势条保留
                    c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                }
            } else {
                getWindow().getDecorView().setSystemUiVisibility(
                        View.SYSTEM_UI_FLAG_FULLSCREEN
                                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
            }
        } catch (Throwable ignored) {
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) applyImmersive();
    }

    @Override
    protected void onDestroy() {
        if (backCallback != null) {
            try {
                getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(backCallback);
            } catch (Throwable ignored) {
            }
            backCallback = null;
        }
        if (web != null) {
            web.removeJavascriptInterface("NativeShell");
            web.destroy();
            web = null;
        }
        if (slimFile != null && slimFile.exists()) slimFile.delete();
        super.onDestroy();
    }
}
