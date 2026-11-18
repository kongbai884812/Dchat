/* camera.js —— 拍照上传 / 相册多选 / 连拍，给 chat-demo 用（零插件）
 *
 * demo 自带的附件链路：input[type=file] multiple → POST {base}/anthropic/v1/files
 * → 消息里带 {type:"image",source:{type:"file",file_id}}。
 * 这里不重写上传，只做三件事：
 *   1. 底部操作条：拍照 / 相册多选；
 *   2. 拍照用带 capture 的 input，Capacitor 的 onShowFileChooser 会转成
 *      ACTION_IMAGE_CAPTURE；拍完自动把操作条弹回来，可以接着再拍或切相册；
 *   3. 拿到的 File 压一下，用 DataTransfer 塞进 demo 自己的上传 input，
 *      再派发 change 让 React 的 onChange 照常跑 —— 预览/进度/重试全沿用原逻辑。
 *
 * 不需要 CAMERA 权限（走系统相机 Intent）；但 Android 11+ 必须在
 * AndroidManifest.xml 里声明 <queries> 的 IMAGE_CAPTURE，否则 resolveActivity()
 * 返回 null，会静默退化成文件选择器。
 */
(function () {
  "use strict";
  if (window.__demoCameraInstalled) return;
  window.__demoCameraInstalled = true;

  var MAX_EDGE = 1600;                    // 长边上限，再大对识图没帮助
  var QUALITY = 0.85;                     // 重编码质量
  var COMPRESS_OVER = 1.2 * 1024 * 1024;  // 超过 1.2MB 才压
  // 一次最多带几张。demo 自己的上限是"单条消息累计 50 个附件"，
  // 这里只是防误选一大把导致上传过久；要完全放开就把它设成 50 或 Infinity。
  var MAX_BATCH = 200;

  /* ---------------- 找 demo 的上传 input ---------------- */
  function findUploadInput() {
    var list = document.querySelectorAll('input[type="file"]');
    var fallback = null;
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      var acc = (el.getAttribute("accept") || "").toLowerCase();
      if (acc.indexOf("zip") > -1) continue;          // 历史导入专用，别碰
      if (el.multiple) return el;                     // demo 的上传框就是 multiple
      if (!fallback) fallback = el;
    }
    return fallback;
  }

  function waitForUploadInput(timeoutMs) {
    return new Promise(function (resolve) {
      var found = findUploadInput();
      if (found) return resolve(found);
      var start = Date.now();
      var timer = setInterval(function () {
        var el = findUploadInput();
        if (el || Date.now() - start > (timeoutMs || 3000)) {
          clearInterval(timer);
          resolve(el || null);
        }
      }, 120);
    });
  }

  /* ---------------- 轻提示 ---------------- */
  var toastEl = null, toastTimer = null;
  function toast(text) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.style.cssText = [
        "position:fixed", "left:50%", "bottom:calc(150px + env(safe-area-inset-bottom,0px))",
        "transform:translateX(-50%)", "max-width:78%", "padding:8px 14px",
        "border-radius:18px", "background:rgba(0,0,0,.78)", "color:#fff",
        "font:13px/1.5 system-ui,-apple-system,sans-serif", "z-index:2147483647",
        "opacity:0", "transition:opacity .18s", "pointer-events:none", "text-align:center"
      ].join(";");
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.style.opacity = "1";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.style.opacity = "0"; }, 2200);
  }

  /* ---------------- 压缩：长边 1600 / JPEG 0.85 ---------------- */
  var PASSTHROUGH = /^image\/(jpeg|jpg|png|gif|webp)$/i; // demo 认这几种，其余一律转 jpeg

  function compress(file) {
    return new Promise(function (resolve) {
      if (!file || !/^image\//.test(file.type || "")) return resolve(file);
      // 小图且格式本身就被支持 —— 不折腾，原样上传
      if (file.size < COMPRESS_OVER && PASSTHROUGH.test(file.type || "")) return resolve(file);
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        try {
          var w = img.naturalWidth, h = img.naturalHeight;
          var scale = Math.min(1, MAX_EDGE / Math.max(w, h));
          var cw = Math.max(1, Math.round(w * scale));
          var ch = Math.max(1, Math.round(h * scale));
          var canvas = document.createElement("canvas");
          canvas.width = cw;
          canvas.height = ch;
          canvas.getContext("2d").drawImage(img, 0, 0, cw, ch);
          canvas.toBlob(function (blob) {
            URL.revokeObjectURL(url);
            if (!blob) return resolve(file);
            resolve(new File([blob], "photo_" + Date.now() + ".jpg", {
              type: "image/jpeg",
              lastModified: Date.now()
            }));
          }, "image/jpeg", QUALITY);
        } catch (e) {
          URL.revokeObjectURL(url);
          resolve(file);
        }
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }

  /* ---------------- 塞给 demo ---------------- */
  function makeDT(files) {
    var dt = new DataTransfer();
    for (var i = 0; i < files.length; i++) dt.items.add(files[i]);
    return dt;
  }

  function feedByEvents(files) {
    var dt = makeDT(files);
    var ta = document.querySelector("textarea");
    if (ta) {
      try {
        ta.focus();
        var paste = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(paste, "clipboardData", { value: dt });
        if (ta.dispatchEvent(paste) === false) return true;
      } catch (e) { /* 继续 */ }
    }
    try {
      var drop = new DragEvent("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(drop, "dataTransfer", { value: dt });
      if (document.dispatchEvent(drop) === false) return true;
    } catch (e) { /* 忽略 */ }
    return false;
  }

  function deliver(files) {
    return waitForUploadInput(3000).then(function (input) {
      if (input) {
        try {
          input.files = makeDT(files).files;
          input.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        } catch (e) { /* 落到事件投喂 */ }
      }
      return feedByEvents(files);
    });
  }

  /* ---------------- 处理一批图片 ---------------- */
  function handleFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []).filter(function (f) {
      return f && /^image\//.test(f.type || "");
    });
    if (!files.length) return Promise.resolve(0);

    if (files.length > MAX_BATCH) {
      toast("一次最多 " + MAX_BATCH + " 张，已取前 " + MAX_BATCH + " 张");
      files = files.slice(0, MAX_BATCH);
    }

    // 串行压缩，避免大图同时解码把 WebView 内存打爆
    var out = [];
    var p = Promise.resolve();
    files.forEach(function (f) {
      p = p.then(function () {
        return compress(f).then(function (c) { out.push(c); });
      });
    });

    return p.then(function () {
      return deliver(out).then(function (ok) {
        if (ok) {
          toast(out.length > 1 ? "已加入 " + out.length + " 张图片" : "照片已加入");
          return out.length;
        }
        toast("没找到上传入口，请手动点「上传文件」");
        return 0;
      });
    });
  }

  /* ================= 输入源 ================= */
  // 相册：多选
  var galleryInput = document.createElement("input");
  galleryInput.type = "file";
  galleryInput.accept = "image/*";
  galleryInput.multiple = true;
  galleryInput.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0;width:1px;height:1px";
  galleryInput.addEventListener("change", function () {
    // files 是活的 FileList，先转成真数组再清空 value，否则会被清成 0 个
    var picked = Array.prototype.slice.call(galleryInput.files || []);
    galleryInput.value = "";
    handleFiles(picked).then(function (n) { if (n) closePanel(); });
  });

  // 文件：任意类型，交给 demo 自己判断
  var fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.multiple = true;
  fileInput.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0;width:1px;height:1px";
  fileInput.addEventListener("change", function () {
    var picked = Array.prototype.slice.call(fileInput.files || []);
    fileInput.value = "";
    if (!picked.length) return;
    // 任意格式原样交给 demo：它有自己的白名单和大小校验，
    // 我们来压缩反而会吞掉"不支持该格式"的提示
    deliver(picked).then(function (ok) {
      if (ok) closePanel();
      else toast("没找到上传入口，请手动点「上传文件」");
    });
  });

  // 兜底：系统相机（getUserMedia 不可用时才用）
  var cameraInput = document.createElement("input");
  cameraInput.type = "file";
  cameraInput.accept = "image/*";
  cameraInput.setAttribute("capture", "environment");
  cameraInput.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0;width:1px;height:1px";
  cameraInput.addEventListener("change", function () {
    var picked = Array.prototype.slice.call(cameraInput.files || []);
    cameraInput.value = "";
    handleFiles(picked).then(function (n) { if (n) openPanel(n); });
  });

  document.body.appendChild(galleryInput);
  document.body.appendChild(fileInput);
  document.body.appendChild(cameraInput);

  /* ================= 自绘相机（getUserMedia） =================
   * 只在 https://localhost 这种安全上下文里有 mediaDevices；
   * 权限由 Capacitor 的 onPermissionRequest 转成系统权限框。
   */
  var cam = {
    overlay: null, video: null, stream: null, track: null,
    facing: "environment", zoom: 1, torch: false, busy: false,
    pushed: false
  };

  function camSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  var CAM_CSS = [
    "#__cam_view{position:fixed;inset:0;z-index:2147483647;background:#000;display:none;",
    "flex-direction:column;font:14px/1.4 system-ui,-apple-system,sans-serif}",
    "#__cam_view.on{display:flex}",
    "#__cam_view .__cv_top{display:flex;align-items:center;justify-content:space-between;",
    "padding:calc(10px + env(safe-area-inset-top,0px)) 16px 10px;color:#fff}",
    "#__cam_view .__cv_top button{background:none;border:0;color:#fff;padding:8px;line-height:0}",
    "#__cam_view svg{width:24px;height:24px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}",
    "#__cam_view .__cb_side svg{width:24px;height:24px}",
    "#__cam_view .__cv_title{font-size:15px;opacity:.92;display:flex;align-items:center;gap:6px}",
    "#__cam_stage{flex:1;position:relative;overflow:hidden;touch-action:none}",
    "#__cam_video{width:100%;height:100%;object-fit:cover;background:#000;opacity:0;transition:opacity .18s;",
    "will-change:transform;transform-origin:50% 50%}",
    "#__cam_zbadge{position:absolute;top:12px;left:50%;transform:translateX(-50%);padding:4px 11px;",
    "border-radius:12px;background:rgba(0,0,0,.55);color:#fff;font-size:12.5px;font-weight:600;",
    "opacity:0;transition:opacity .16s;pointer-events:none}",
    "#__cam_bottom{display:flex;align-items:center;justify-content:space-between;",
    "padding:16px 28px calc(22px + env(safe-area-inset-bottom,0px));background:#000}",
    "#__cam_bottom .__cb_side{width:52px;height:52px;border-radius:50%;border:0;",
    "background:rgba(255,255,255,.14);color:#fff;font-size:20px;display:flex;",
    "align-items:center;justify-content:center}",
    "#__cam_bottom .__cb_side.off{opacity:.35}",
    "#__cam_shutter{width:74px;height:74px;border-radius:50%;border:5px solid #fff;",
    "background:#fff;padding:0}",
    "#__cam_shutter:active{transform:scale(.94)}",
    "#__cam_prev{position:fixed;inset:0;z-index:2147483647;background:#0b0b0c;display:none;",
    "flex-direction:column;font:14px/1.4 system-ui,-apple-system,sans-serif}",
    "#__cam_prev.on{display:flex}",
    "#__cam_prev .__pv_top{display:flex;align-items:center;justify-content:space-between;",
    "padding:calc(10px + env(safe-area-inset-top,0px)) 12px 8px;color:#fff}",
    "#__cam_prev .__pv_top button{background:none;border:0;color:#fff;padding:8px;line-height:0}",
    "#__cam_prev .__pv_spacer{width:40px;height:40px}",
    "#__cam_prev svg{width:24px;height:24px;fill:none;stroke:currentColor;stroke-width:2;",
    "stroke-linecap:round;stroke-linejoin:round}",
    "#__cam_prev .__pv_img{flex:1;display:flex;align-items:center;justify-content:center;",
    "overflow:hidden;padding:2px 12px 8px}",
    "#__cam_prev .__pv_img img{max-width:100%;max-height:100%;border-radius:12px;object-fit:contain}",
    "#__cam_chips{display:flex;gap:8px;padding:8px 12px 10px;overflow-x:auto;white-space:nowrap}",
    "#__cam_chips button{flex:none;border:0;border-radius:18px;background:#fff;",
    "color:#14161a;padding:10px 16px;font-size:14px;line-height:1}",
    "#__cam_chips button:active{background:#e9ecf2}",
    "#__pv_composer{margin:0 12px calc(12px + env(safe-area-inset-bottom,0px));",
    "background:#1c1c1e;border-radius:24px;padding:12px 12px 10px}",
    "#__pv_composer textarea{display:block;width:100%;box-sizing:border-box;border:0;outline:0;",
    "resize:none;overflow:hidden;background:transparent;color:#fff;",
    "font:16px/1.4 system-ui,-apple-system,sans-serif;min-height:26px;max-height:96px;",
    "padding:2px 4px 10px}",
    "#__pv_composer textarea::placeholder{color:rgba(255,255,255,.42)}",
    "#__pv_composer .__pv_tools{display:flex;align-items:center;gap:8px}",
    "#__pv_composer .__pv_pill{flex:none;display:flex;align-items:center;gap:5px;",
    "border:1px solid rgba(255,255,255,.18);border-radius:16px;background:transparent;",
    "color:#e8e8ea;padding:7px 12px;font-size:13px;line-height:1}",
    "#__pv_composer .__pv_pill.on{border-color:rgba(77,107,254,.85);",
    "background:rgba(77,107,254,.15);color:#c9d3ff}",
    "#__pv_composer .__pv_pill svg{width:15px;height:15px}",
    "#__pv_composer .__pv_grow{flex:1}",
    "#__pv_composer .__pv_rnd{flex:none;width:34px;height:34px;border-radius:50%;",
    "border:1.5px solid rgba(255,255,255,.65);background:transparent;color:#fff;",
    "display:flex;align-items:center;justify-content:center;padding:0;line-height:0}",
    "#__pv_composer .__pv_rnd svg{width:18px;height:18px}",
    "#__pv_composer .__pv_main{flex:none;width:34px;height:34px;border-radius:50%;",
    "border:1.5px solid rgba(255,255,255,.65);background:transparent;color:#fff;",
    "display:flex;align-items:center;justify-content:center;padding:0;line-height:0;",
    "transition:background .18s,border-color .18s}",
    "#__pv_composer .__pv_main.send{border-color:#4d6bfe;background:#4d6bfe}",
    "#__pv_composer .__pv_main svg{width:18px;height:18px}",
    "#__pv_composer .__pv_main.send svg{stroke-width:2.4}",
    "#__pv_hold{display:none;height:44px;margin:4px 0 10px;border-radius:12px;",
    "background:rgba(255,255,255,.1);color:#fff;align-items:center;justify-content:center;",
    "font-size:15px;user-select:none;-webkit-user-select:none;touch-action:none}",
    "#__pv_composer.voice #__pv_text{display:none}",
    "#__pv_composer.voice #__pv_hold{display:flex}",
    "#__pv_composer.voice #__pv_hold.rec{background:rgba(77,107,254,.28)}",
    /* demo 自带的删除按钮只在 :hover 显示，手机上永远看不见；
       这里强制常显，并做成右上角红色圆形 × */
    ".attachment-ed6f47 .remove-ed6f47{opacity:1!important;width:20px!important;height:20px!important;",
    "top:2px!important;right:2px!important;background:#ff3b30!important;color:#fff!important;",
    "box-shadow:0 1px 4px rgba(0,0,0,.45)!important;z-index:3}",
    ".attachment-ed6f47 .remove-ed6f47 svg{width:12px;height:12px;stroke:#fff}",
    ".attachment-ed6f47{padding-right:0}"
  ].join("");

  function injectCamCss() {
    if (document.getElementById("__cam_css")) return;
    var st = document.createElement("style");
    st.id = "__cam_css";
    st.textContent = CAM_CSS;
    document.head.appendChild(st);
  }

  function buildCam() {
    if (cam.overlay) return;
    injectCamCss();

    var view = document.createElement("div");
    view.id = "__cam_view";
    view.innerHTML =
      '<div class="__cv_top">' +
      '  <button type="button" data-act="close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>' +
      '  <div class="__cv_title">图像识别</div>' +
      '  <button type="button" data-act="flip"><svg viewBox="0 0 24 24"><path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><path d="M20.5 4v5h-5"/></svg></button>' +
      "</div>" +
      '<div id="__cam_stage">' +
      '  <video id="__cam_video" autoplay playsinline muted></video>' +
      '  <div id="__cam_zbadge"></div>' +
      "</div>" +
      '<div id="__cam_bottom">' +
      '  <button type="button" class="__cb_side" data-act="torch"><svg viewBox="0 0 24 24"><path d="M13 2.5 5 13.5h6l-1 8 9-12h-6z"/></svg></button>' +
      '  <button type="button" id="__cam_shutter" aria-label="拍照"></button>' +
      '  <button type="button" class="__cb_side" data-act="gallery"><svg viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="15" rx="2.5"/><circle cx="8.5" cy="10" r="1.6"/><path d="M21 15.5l-4.5-4.5L7 20"/></svg></button>' +
      "</div>";
    document.body.appendChild(view);

    cam.overlay = view;
    cam.video = view.querySelector("#__cam_video");
    cam.video.addEventListener("loadeddata", function () {
      // 新画面已就绪，撤掉切换时用作遮挡的上一帧，避免闪现播放图标
      cam.video.poster = "";
      cam.video.style.opacity = "1";
    });

    view.addEventListener("click", function (e) {
      var btn = e.target.closest("button");
      if (!btn) return;
      var act = btn.getAttribute("data-act");
      if (act === "close") closeCamera();
      else if (act === "flip") switchFacing();
      else if (act === "torch") toggleTorch();
      else if (act === "gallery") { closeCamera(); galleryInput.click(); }
    });
    view.querySelector("#__cam_shutter").addEventListener("click", shoot);
    bindPinch(view.querySelector("#__cam_stage"));
  }

  function toggleTorch() {
    if (!cam.track || !cam.track.applyConstraints) return;
    var caps = cam.track.getCapabilities ? cam.track.getCapabilities() : {};
    if (!caps || !caps.torch) { toast("这台设备不支持闪光灯常亮"); return; }
    cam.torch = !cam.torch;
    cam.track.applyConstraints({ advanced: [{ torch: cam.torch }] }).catch(function () {
      cam.torch = false;
      toast("闪光灯切换失败");
    });
    var btn = document.querySelector('#__cam_view [data-act="torch"]');
    if (btn) btn.classList.toggle("off", !cam.torch);
  }

  /* ---------- 双指捏合变焦（软件实现） ----------
   * 不用 track 的 zoom 约束：Android WebView 的 getCapabilities()
   * 多数不返回 zoom，所以靠 CSS 缩放取景画面 + 快门时中心裁切来等效。
   */
  var VIEW_ZOOM_MAX = 4;
  var pinch = { active: false, startDist: 0, startZoom: 1, timer: 0 };

  function touchDist(a, b) {
    var dx = a.clientX - b.clientX, dy = a.clientY - b.clientY;
    return Math.sqrt(dx * dx + dy * dy) || 1;
  }

  function showZoomBadge() {
    var badge = document.getElementById("__cam_zbadge");
    if (!badge) return;
    if (cam.zoom > 1.001) {
      badge.textContent = cam.zoom.toFixed(1) + "×";
      badge.style.opacity = "1";
    } else {
      badge.style.opacity = "0";
    }
  }

  function setViewZoom(z) {
    var next = Math.min(VIEW_ZOOM_MAX, Math.max(1, z));
    cam.zoom = next;
    if (cam.video) {
      cam.video.style.transform = next > 1.001 ? "scale(" + next + ")" : "";
    }
    showZoomBadge();
  }

  function bindPinch(stage) {
    stage.addEventListener("touchstart", function (e) {
      if (e.touches.length !== 2) return;
      pinch.active = true;
      pinch.startDist = touchDist(e.touches[0], e.touches[1]);
      pinch.startZoom = cam.zoom;
    }, { passive: true });

    stage.addEventListener("touchmove", function (e) {
      if (!pinch.active || e.touches.length !== 2) return;
      e.preventDefault();
      var d = touchDist(e.touches[0], e.touches[1]);
      setViewZoom(pinch.startZoom * (d / pinch.startDist));
    }, { passive: false });

    function end(e) {
      if (!pinch.active) return;
      if (e.touches && e.touches.length >= 2) return;
      pinch.active = false;
      if (cam.zoom <= 1.02) setViewZoom(1);
      clearTimeout(pinch.timer);
      pinch.timer = setTimeout(function () {
        var badge = document.getElementById("__cam_zbadge");
        if (badge) badge.style.opacity = "0";
      }, 1300);
    }
    stage.addEventListener("touchend", end, { passive: true });
    stage.addEventListener("touchcancel", end, { passive: true });
  }

  function switchFacing() {
    cam.facing = cam.facing === "environment" ? "user" : "environment";
    startStream(cam.facing).catch(function () {
      cam.facing = cam.facing === "environment" ? "user" : "environment";
      toast("切换摄像头失败");
    });
  }

  /** 把当前画面截成 poster，切换摄像头期间用它挡住空白，避免闪现播放图标。 */
  function freezeFrame() {
    var v = cam.video;
    if (!v || !v.videoWidth) return;
    try {
      var c = document.createElement("canvas");
      var k = Math.min(1, 360 / Math.max(v.videoWidth, v.videoHeight));
      c.width = Math.max(1, Math.round(v.videoWidth * k));
      c.height = Math.max(1, Math.round(v.videoHeight * k));
      c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
      v.poster = c.toDataURL("image/jpeg", 0.5);
    } catch (e) {}
  }

  function stopStream() {
    freezeFrame();
    if (cam.stream) {
      cam.stream.getTracks().forEach(function (t) { t.stop(); });
      cam.stream = null;
      cam.track = null;
    }
    if (cam.video) {
      cam.video.style.opacity = "0";
      cam.video.srcObject = null;
    }
  }

  function startStream(facing) {
    stopStream();
    var constraints = {
      audio: false,
      video: {
        facingMode: { ideal: facing },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      }
    };
    return navigator.mediaDevices.getUserMedia(constraints).then(function (stream) {
      cam.stream = stream;
      cam.track = stream.getVideoTracks()[0];
      cam.video.srcObject = stream;
      var playing = cam.video.play();
      if (playing && playing.catch) playing.catch(function () {});

      setViewZoom(1);
      var caps = cam.track.getCapabilities ? cam.track.getCapabilities() : {};
      var btn = document.querySelector('#__cam_view [data-act="torch"]');
      if (btn) btn.classList.toggle("off", !(caps && caps.torch));
      return stream;
    });
  }

  function setModal(v) {
    try { if (window.NativeShell && window.NativeShell.setModal) window.NativeShell.setModal(v); } catch (e) {}
  }

  function openCamera() {
    if (!camSupported()) { cameraInput.click(); return; }
    setModal(1);
    buildCam();
    cam.overlay.classList.add("on");
    if (!cam.pushed) {
      cam.pushed = true;
      try { history.pushState({ __cam: 1 }, ""); } catch (e) {}
    }
    cam.facing = "environment";
    startStream(cam.facing).catch(function () {
      closeCamera();               // 连同刚压入的历史一起回退
      toast("相机打不开，改用系统相机");
      cameraInput.click();
    });
  }

  function closeCamera(silent) {
    setModal(0);
    stopStream();
    if (cam.overlay) cam.overlay.classList.remove("on");
    if (cam.pushed) {
      cam.pushed = false;
      if (!silent) { try { history.back(); } catch (e) {} }
    }
  }

  window.addEventListener("popstate", function () {
    if (cam.pushed) {
      cam.pushed = false;
      stopStream();
      if (cam.overlay) cam.overlay.classList.remove("on");
    }
  });

  function shoot() {
    if (cam.busy) return;
    var v = cam.video;
    if (!v || !v.videoWidth) { toast("画面还没准备好"); return; }
    cam.busy = true;

    var vw = v.videoWidth, vh = v.videoHeight;
    // 变焦时按中心裁切，保证拍到的就是屏幕上看到的那块
    var z = cam.zoom > 1.001 ? cam.zoom : 1;
    var cw = Math.max(1, Math.round(vw / z));
    var ch = Math.max(1, Math.round(vh / z));
    var sx = Math.round((vw - cw) / 2);
    var sy = Math.round((vh - ch) / 2);
    var scale = Math.min(1, MAX_EDGE / Math.max(cw, ch));
    var c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(cw * scale));
    c.height = Math.max(1, Math.round(ch * scale));
    c.getContext("2d").drawImage(v, sx, sy, cw, ch, 0, 0, c.width, c.height);

    c.toBlob(function (blob) {
      cam.busy = false;
      if (!blob) { toast("拍照失败"); return; }
      var file = new File([blob], "photo_" + Date.now() + ".jpg", {
        type: "image/jpeg",
        lastModified: Date.now()
      });
      closeCamera();
      showPreview(file, c.toDataURL("image/jpeg", 0.6));
    }, "image/jpeg", 0.92);
  }

  /* ================= 拍完的预览 ================= */
  var CHIPS = ["这是什么", "分析一下", "怎么办", "解释一下"];

  function showPreview(file, dataUrl) {
    setModal(1);
    injectCamCss();
    var box = document.getElementById("__cam_prev");
    if (!box) {
      box = document.createElement("div");
      box.id = "__cam_prev";
      box.innerHTML =
        '<div class="__pv_top">' +
        '  <button type="button" data-act="exit" aria-label="退出">' +
        '    <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>' +
        '  <span class="__pv_spacer"></span>' +
        '  <button type="button" data-act="crop" aria-label="裁剪">' +
        '    <svg viewBox="0 0 24 24"><path d="M4 9V4h5"/><path d="M15 4h5v5"/>' +
        '    <path d="M20 15v5h-5"/><path d="M9 20H4v-5"/></svg></button>' +
        "</div>" +
        '<div class="__pv_img"><img alt="拍摄结果" /></div>' +
        '<div id="__cam_chips"></div>' +
        '<div id="__pv_composer">' +
        '  <textarea id="__pv_text" rows="1" placeholder="发消息或按住说话"></textarea>' +
        '  <div id="__pv_hold">按住 说话</div>' +
        '  <div class="__pv_tools">' +
        '    <button type="button" class="__pv_pill" data-act="think">' +
        '      <svg viewBox="0 0 24 24"><path d="M12 4.5c2.2 0 3.6 1.3 3.9 3.1 1.4.5 2.3 1.8 2.3 3.3 0 1.6-1 3-2.6 3.4-.4 1.7-1.9 3-3.9 3"/>' +
        '      <path d="M12 4.5c-2.6 0-4.4 1.8-4.4 4 0 .5.1.9.2 1.3"/>' +
        '      <path d="M7.8 9.8c-.3.4-.5.9-.5 1.5 0 1 .5 1.8 1.3 2.3"/>' +
        '      <path d="M14 10.2l1.6 1.4-1.6 1.4"/></svg>深度思考</button>' +
        '    <button type="button" class="__pv_pill on" data-act="search">' +
        '      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/>' +
        '      <path d="M3.5 12h17M12 3.5c2.4 2.4 3.6 5.4 3.6 8.5s-1.2 6.1-3.6 8.5c-2.4-2.4-3.6-5.4-3.6-8.5S9.6 5.9 12 3.5z"/></svg>智能搜索</button>' +
        '    <span class="__pv_grow"></span>' +
        '    <button type="button" class="__pv_rnd" data-act="plus" aria-label="添加">' +
        '      <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>' +
        '    <button type="button" class="__pv_main" data-act="main" aria-label="发送">' +
        '      <svg viewBox="0 0 24 24"><path d="M12 19V6M6 11.5 12 5.5l6 6"/></svg></button>' +
        "  </div>" +
        "</div>";
      document.body.appendChild(box);
    }

    var img = box.querySelector("img");
    var current = { file: file, url: null };
    if (dataUrl) {
      img.src = dataUrl;
    } else {
      current.url = URL.createObjectURL(file);
      img.src = current.url;
    }

    var chipBox = box.querySelector("#__cam_chips");
    chipBox.innerHTML = "";
    CHIPS.forEach(function (label) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = label + " →";
      b.addEventListener("click", function () {
        sendPhoto(current.file, label);
      });
      chipBox.appendChild(b);
    });

    var composer = box.querySelector("#__pv_composer");
    var mainBtn = box.querySelector('[data-act="main"]');
    var holdEl = box.querySelector("#__pv_hold");
    var textEl = box.querySelector("#__pv_text");

    var ICON_SEND = '<svg viewBox="0 0 24 24"><path d="M12 19V6M6 11.5 12 5.5l6 6"/></svg>';
    var ICON_MIC =
      '<svg viewBox="0 0 24 24"><rect x="9.2" y="3" width="5.6" height="11" rx="2.8"/>' +
      '<path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3"/></svg>';
    var ICON_KB =
      '<svg viewBox="0 0 24 24"><rect x="2.6" y="6" width="18.8" height="12" rx="2.4"/>' +
      '<path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8"/></svg>';

    /** 和主页面同一个规则：有字→发送，没字→麦克风，语音模式→键盘 */
    function syncMain() {
      var voice = composer.classList.contains("voice");
      var hasText = !!textEl.value.trim();
      mainBtn.classList.toggle("send", !voice && hasText);
      mainBtn.innerHTML = voice ? ICON_KB : hasText ? ICON_SEND : ICON_MIC;
      mainBtn.setAttribute(
        "aria-label",
        voice ? "键盘" : hasText ? "发送" : "语音输入"
      );
    }

    function setVoiceMode(on) {
      composer.classList.toggle("voice", on);
      if (on) {
        textEl.blur();
        holdEl.textContent = "按住 说话";
      } else {
        holdEl.classList.remove("rec");
        holdEl.textContent = "按住 说话";
      }
      syncMain();
    }

    // 输入框随内容长高，同时联动右下角按钮
    textEl.addEventListener("input", function () {
      textEl.style.height = "auto";
      textEl.style.height = Math.min(96, textEl.scrollHeight) + "px";
      syncMain();
    });

    // 按住说话：直接复用主页面的录音与识别
    var hold = { down: false, y: 0 };
    holdEl.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      hold.down = true;
      hold.y = e.clientY;
      holdEl.classList.add("rec");
      holdEl.textContent = "松开发送，上滑取消";
      if (holdEl.setPointerCapture) {
        try { holdEl.setPointerCapture(e.pointerId); } catch (err) {}
      }
      if (window.__voiceStart) window.__voiceStart();
    });
    function endHold(e) {
      if (!hold.down) return;
      hold.down = false;
      holdEl.classList.remove("rec");
      holdEl.textContent = "识别中…";
      var canceled = hold.y - (e && e.clientY ? e.clientY : hold.y) > 56;
      if (window.__voiceFinish) window.__voiceFinish(canceled);
    }
    holdEl.addEventListener("pointerup", endHold);
    holdEl.addEventListener("pointercancel", function (e) { endHold(e); });

    // 识别结果回到预览页输入框
    if (window.__voiceSetSink) {
      window.__voiceSetSink(function (transcript) {
        textEl.value = transcript;
        textEl.dispatchEvent(new Event("input", { bubbles: true }));
        setVoiceMode(false);
        holdEl.textContent = "按住 说话";
      });
    }

    setVoiceMode(false);
    syncMain();

    // 深度思考 / 智能搜索：直接切换聊天页的同一组开关
    function syncPills() {
      var map = [
        ["think", '#root [aria-label="深度思考"]'],
        ["search", '#root [aria-label="智能搜索"]']
      ];
      map.forEach(function (pair) {
        var src = document.querySelector(pair[1]);
        var pill = box.querySelector('[data-act="' + pair[0] + '"]');
        if (src && pill) {
          pill.classList.toggle("on", src.getAttribute("aria-pressed") === "true");
        }
      });
    }
    syncPills();

    box.onclick = function (e) {
      var btn = e.target.closest("button");
      if (!btn) return;
      var act = btn.getAttribute("data-act");
      if (act === "exit") {
        hidePreview();
      } else if (act === "crop") {
        openCrop(current, img);
      } else if (act === "main") {
        if (composer.classList.contains("voice")) {
          setVoiceMode(false);
          try { textEl.focus(); } catch (err) {}
        } else if (textEl.value.trim()) {
          sendPhoto(current.file, textEl.value.trim());
        } else {
          setVoiceMode(true);
        }
      } else if (act === "think" || act === "search") {
        var target = document.querySelector(
          act === "think" ? '#root [aria-label="深度思考"]' : '#root [aria-label="智能搜索"]'
        );
        if (target) target.click();
        syncPills();
      } else if (act === "plus") {
        toast("请退出后从聊天页添加");
      } else if (act === "mic") {
        toast("语音输入请在聊天页使用");
      }
    };

    box.classList.add("on");
  }


  /** 照片 + 文字一起交给聊天页：上传完成后自动点发送 */
  function sendPhoto(file, text) {
    deliver([file]).then(function (ok) {
      if (!ok) { toast("没找到上传入口，请手动添加"); return; }
      if (text) fillComposer(text);
      hidePreview();
      autoSend();
    });
  }

  function autoSend() {
    var tries = 0;
    (function tick() {
      var btn = document.querySelector('#root [aria-label="发送"]');
      if (btn && btn.getAttribute("aria-disabled") !== "true") {
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        btn.click();
        return;
      }
      if (++tries > 80) { toast("图片已加入，点发送即可"); return; }
      setTimeout(tick, 200);
    })();
  }

  /* ================= 拍完再框选一块（裁剪） ================= */
  function injectCropCss() {
    if (document.getElementById("__cam_crop_css")) return;
    var st = document.createElement("style");
    st.id = "__cam_crop_css";
    st.textContent =
      "#__cam_crop{position:fixed;inset:0;z-index:2147483647;background:#0b0b0c;color:#fff;" +
      "display:flex;flex-direction:column;font:15px/1.4 system-ui,-apple-system,sans-serif}" +
      "#__cam_crop .__cr_top{display:flex;align-items:center;justify-content:space-between;" +
      "padding:calc(10px + env(safe-area-inset-top,0px)) 16px 10px;color:#fff}" +
      "#__cam_crop .__cr_top button{background:none;border:0;color:#fff;padding:8px;line-height:0}" +
      "#__cam_crop .__cr_top button.__cr_text{font-size:15px;line-height:1.4;opacity:.92;padding:8px 4px}" +
      "#__cam_crop svg{width:24px;height:24px;fill:none;stroke:currentColor;stroke-width:2;" +
      "stroke-linecap:round;stroke-linejoin:round}" +
      "#__cam_crop .__cr_title{font-size:15px;opacity:.92}" +
      "#__cam_crop .__cr_stage{position:relative;flex:1;display:flex;align-items:center;justify-content:center;" +
      "overflow:hidden;padding:8px 12px calc(18px + env(safe-area-inset-bottom,0px))}" +
      "#__cam_crop .__cr_stage img{max-width:100%;max-height:100%;object-fit:contain;" +
      "user-select:none;-webkit-user-select:none;pointer-events:none}" +
      "#__cam_crop .__cr_rect{position:absolute;border:1px solid rgba(255,255,255,.9);" +
      "box-shadow:0 0 0 9999px rgba(0,0,0,.55);touch-action:none;box-sizing:border-box}" +
      "#__cam_crop .__cr_h{position:absolute;width:26px;height:26px;border-radius:50%;" +
      "background:#fff;border:2px solid #4d6bfe;box-sizing:border-box}" +
      "#__cam_crop .__cr_nw{left:-13px;top:-13px}" +
      "#__cam_crop .__cr_ne{right:-13px;top:-13px}" +
      "#__cam_crop .__cr_sw{left:-13px;bottom:-13px}" +
      "#__cam_crop .__cr_se{right:-13px;bottom:-13px}";
    document.head.appendChild(st);
  }

  function openCrop(current, previewImg) {
    var old = document.getElementById("__cam_crop");
    if (old && old.parentNode) old.parentNode.removeChild(old);

    var box = document.createElement("div");
    box.id = "__cam_crop";
    box.innerHTML =
      '<div class="__cr_top">' +
      '  <button type="button" data-act="cancel"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>' +
      '  <div class="__cr_title">裁剪</div>' +
      '  <button type="button" class="__cr_text" data-act="ok">完成</button>' +
      "</div>" +
      '<div class="__cr_stage">' +
      '  <img alt="待裁剪图片" />' +
      '  <div class="__cr_rect">' +
      '    <i class="__cr_h __cr_nw" data-h="nw"></i><i class="__cr_h __cr_ne" data-h="ne"></i>' +
      '    <i class="__cr_h __cr_sw" data-h="sw"></i><i class="__cr_h __cr_se" data-h="se"></i>' +
      "  </div>" +
      "</div>";
    document.body.appendChild(box);
    injectCropCss();

    var stage = box.querySelector(".__cr_stage");
    var img = box.querySelector("img");
    var rect = box.querySelector(".__cr_rect");
    var srcUrl = URL.createObjectURL(current.file);
    var drag = null;

    function setRect(x, y, w, h) {
      rect.style.left = x + "px";
      rect.style.top = y + "px";
      rect.style.width = w + "px";
      rect.style.height = h + "px";
    }

    /** 图片在 stage 里的显示区域（px） */
    function bounds() {
      var b = img.getBoundingClientRect();
      var s = stage.getBoundingClientRect();
      return { x: b.left - s.left, y: b.top - s.top, w: b.width, h: b.height };
    }

    img.onload = function () {
      var b = bounds();
      setRect(b.x + b.w * 0.1, b.y + b.h * 0.1, b.w * 0.8, b.h * 0.8);
    };
    img.src = srcUrl;

    function begin(e, mode, dir) {
      e.preventDefault();
      var r = rect.getBoundingClientRect();
      var s = stage.getBoundingClientRect();
      drag = { mode: mode, dir: dir, px: e.clientX, py: e.clientY,
               x: r.left - s.left, y: r.top - s.top, w: r.width, h: r.height };
      try { rect.setPointerCapture(e.pointerId); } catch (err) {}
    }

    rect.addEventListener("pointerdown", function (e) {
      var dir = e.target && e.target.getAttribute ? e.target.getAttribute("data-h") : null;
      begin(e, dir ? "resize" : "move", dir);
    });

    rect.addEventListener("pointermove", function (e) {
      if (!drag) return;
      var b = bounds(), MIN = 44;
      var dx = e.clientX - drag.px, dy = e.clientY - drag.py;
      var x = drag.x, y = drag.y, w = drag.w, h = drag.h;
      if (drag.mode === "move") {
        x = Math.min(Math.max(b.x, drag.x + dx), b.x + b.w - w);
        y = Math.min(Math.max(b.y, drag.y + dy), b.y + b.h - h);
      } else {
        var d = drag.dir || "";
        if (d.indexOf("w") >= 0) {
          var nx = Math.min(Math.max(b.x, drag.x + dx), drag.x + w - MIN);
          w = drag.w + (drag.x - nx);
          x = nx;
        }
        if (d.indexOf("e") >= 0) w = Math.max(MIN, Math.min(drag.w + dx, b.x + b.w - drag.x));
        if (d.indexOf("n") >= 0) {
          var ny = Math.min(Math.max(b.y, drag.y + dy), drag.y + h - MIN);
          h = drag.h + (drag.y - ny);
          y = ny;
        }
        if (d.indexOf("s") >= 0) h = Math.max(MIN, Math.min(drag.h + dy, b.y + b.h - drag.y));
      }
      setRect(x, y, w, h);
    });

    function endDrag() { drag = null; }
    rect.addEventListener("pointerup", endDrag);
    rect.addEventListener("pointercancel", endDrag);

    function close() {
      try { URL.revokeObjectURL(srcUrl); } catch (e) {}
      if (box.parentNode) box.parentNode.removeChild(box);
    }

    box.onclick = function (e) {
      var btn = e.target.closest("button");
      if (!btn) return;
      var act = btn.getAttribute("data-act");
      if (act === "cancel") { close(); return; }
      if (act !== "ok") return;

      var b = bounds();
      var s = stage.getBoundingClientRect();
      var r = rect.getBoundingClientRect();
      var x = Math.max(0, r.left - s.left - b.x);
      var y = Math.max(0, r.top - s.top - b.y);
      var w = Math.min(b.w - x, r.width);
      var h = Math.min(b.h - y, r.height);
      if (w < 8 || h < 8) { toast("选区太小"); return; }

      var scale = img.naturalWidth / b.w;
      var sw = Math.max(1, Math.round(w * scale));
      var sh = Math.max(1, Math.round(h * scale));
      var sx = Math.max(0, Math.round(x * scale));
      var sy = Math.max(0, Math.round(y * scale));

      var cap = Math.min(1, MAX_EDGE / Math.max(sw, sh));
      var c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(sw * cap));
      c.height = Math.max(1, Math.round(sh * cap));
      c.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);

      c.toBlob(function (blob) {
        if (!blob) { toast("裁剪失败"); return; }
        var f = new File([blob], "crop_" + Date.now() + ".jpg",
          { type: "image/jpeg", lastModified: Date.now() });
        current.file = f;
        if (current.url) { try { URL.revokeObjectURL(current.url); } catch (err) {} }
        current.url = URL.createObjectURL(f);
        previewImg.src = current.url;
        close();
        toast("已裁剪");
      }, "image/jpeg", 0.92);
    };
  }

  function hidePreview() {
    if (window.__voiceSetSink) window.__voiceSetSink(null);
    var box = document.getElementById("__cam_prev");
    if (box) {
      box.classList.remove("on");
      var composer = box.querySelector("#__pv_composer");
      if (composer) composer.classList.remove("voice");
      var ta = box.querySelector("#__pv_text");
      if (ta) {
        ta.value = "";
        ta.style.height = "";
        ta.blur();
      }
    }
    setModal(0);
  }

  // 把快捷提问填进 demo 的输入框（React 受控组件要用原生 setter）
  function fillComposer(text) {
    var ta = document.querySelector("#root textarea") || document.querySelector("textarea");
    if (!ta) return false;
    try {
      var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(ta, text);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.focus();
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ================= 面板：交给 React 渲染 =================
   * 面板在输入框卡片内部展开、把整个输入区连同聊天内容一起顶上去，
   * 不再是带遮罩的固定浮层。这里只负责提供三个输入源和相机。
   */
  function openPanel(justAdded) {
    if (window.__openAttachPanel) window.__openAttachPanel(justAdded || 0);
  }

  function closePanel() {
    if (window.__closeAttachPanel) window.__closeAttachPanel();
  }

  // React 面板上的三个按钮点这里
  window.__dchatPick = function (act) {
    if (act === "camera") openCamera();
    else if (act === "gallery") galleryInput.click();
    else if (act === "file") fileInput.click();
  };

  /* ================= 接管页面按钮 ================= */
  function closest(el, sel) {
    while (el && el.nodeType === 1) {
      if (el.matches && el.matches(sel)) return el;
      el = el.parentElement;
    }
    return null;
  }

  document.addEventListener("click", function (e) {
    var t = e.target;
    if (!t || t.nodeType !== 1) return;

    // 左上角侧边栏按钮：元素本身很小，按坐标外扩补热区。
    // 三个前提缺一不可，否则会误伤：
    //   · 真实手指点击（程序化 click 坐标恒为 0，会落进左上角）
    //   · 相机 / 预览 / 面板都没打开（否则会抢走它们自己的按钮）
    //   · 点的是按钮之外但足够近的地方
    var trusted = e.isTrusted !== false && (e.clientX !== 0 || e.clientY !== 0);
    var overlayOpen =
      (cam.overlay && cam.overlay.classList.contains("on")) ||
      (document.getElementById("__cam_prev") &&
        document.getElementById("__cam_prev").classList.contains("on"));

    if (trusted && !overlayOpen && e.clientX < 240 && e.clientY < 260) {
      var menu = document.querySelector('[aria-label="打开边栏"]');
      if (menu && menu !== t && !menu.contains(t)) {
        var r = menu.getBoundingClientRect();
        var pad = 32;
        if (e.clientX >= r.left - pad && e.clientX <= r.right + pad &&
            e.clientY >= r.top - pad && e.clientY <= r.bottom + pad) {
          e.preventDefault();
          e.stopPropagation();
          menu.click();
          return;
        }
      }
    }

    // 注意：导入历史的「上传」不再由 JS 拦截。
    // 交给原生 onShowFileChooser 判断 accept 含 zip 时走精简流程，
    // 避免 JS 吃掉点击、原生又没起来的两头空。
  }, true);

  /* 左上角侧边栏按钮：放大点击区域 */
  (function () {
    var st = document.createElement("style");
    // 只扩大可点击范围，不动图案本身
    st.textContent = '[aria-label="打开边栏"]:active{opacity:.6}';
    document.head.appendChild(st);
  })();

  /* ================= 精简导入 ================= */
  var slimBusy = false;

  function b64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function findImportInput() {
    var list = document.querySelectorAll('input[type="file"]');
    for (var i = 0; i < list.length; i++) {
      var acc = (list[i].getAttribute("accept") || "").toLowerCase();
      if (acc.indexOf("zip") > -1) return list[i];
    }
    return null;
  }

  function feedImport(file) {
    var input = findImportInput();
    if (!input) { toast("找不到导入入口"); return; }
    try {
      var dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (e) {
      toast("投喂失败：" + e.message);
    }
  }

  // Java 侧处理完回调：size = -1 表示失败
  window.__slimReady = function (size) {
    if (!size || size < 0) {
      slimBusy = false;
      toast("精简失败，文件可能不是有效 ZIP");
      return;
    }
    try {
      var CH = 512 * 1024;
      var parts = [];
      for (var off = 0; off < size; off += CH) {
        var n = Math.min(CH, size - off);
        var b64 = window.NativeShell.readChunk(off, n);
        if (!b64) throw new Error("读取片段失败 @ " + off);
        parts.push(b64ToBytes(b64));
      }
      var file = new File(parts, "slim-archive.zip", { type: "application/zip" });
      feedImport(file);
      toast("已精简到 " + (size / 1024 / 1024).toFixed(1) + "MB，正在导入…");
    } catch (e) {
      toast("精简导入失败：" + e.message);
    } finally {
      slimBusy = false;
    }
  };

  // 供原生返回键调用：关掉当前浮层
  window.__closeCam = function () {
    var prev = document.getElementById("__cam_prev");
    if (prev && prev.classList.contains("on")) { hidePreview(); return true; }
    if (cam.overlay && cam.overlay.classList.contains("on")) { closeCamera(); return true; }
    return false;
  };

  /* ================= 按键反馈：按下深陷 ================= */
  (function () {
    var st = document.createElement("style");
    st.textContent = [
      // 全局：按下时下沉 1px + 内侧阴影，做出"被按进去"的感觉
      "button:active, [role='button']:active, a[href]:active{",
      "  transform:translateY(1px)!important;",
      "  box-shadow:inset 0 2px 6px rgba(0,0,0,.18), inset 0 -1px 0 rgba(255,255,255,.35)!important;",
      "  filter:brightness(.96);",
      "}",
      "button,[role='button'],a[href]{transition:transform .06s ease, box-shadow .06s ease, filter .06s ease}",
      // 自定义控件：统一成同一种深陷
      "#__cam_grid button:active{background:#e3e7ee!important}",
      "#__cam_view .__cb_side:active,",
      "#__cam_view .__cv_top button:active,",
      "#__cam_prev button:active{opacity:.75}",
      "#__diag_btn:active{opacity:.6!important}",
      // 这些按钮不是 <button>，上面那条选择器够不到，单独补（必须 !important）
      "[aria-label='打开边栏']:active,[aria-label='上传文件']:active,",
      "[aria-label='添加附件']:active,[aria-label='语音输入']:active{",
      "  transform:translateY(1px)!important;",
      "  box-shadow:inset 0 2px 6px rgba(0,0,0,.20), inset 0 -1px 0 rgba(255,255,255,.4)!important;",
      "  filter:brightness(.93)!important;",
      "}",
      // 右上角问号：按下去是圆形凹陷
      "#__diag_btn{border-radius:50%!important}",
      "#__diag_btn:active{",
      "  transform:translateY(1px)!important;",
      "  background:rgba(0,0,0,.07)!important;",
      "  box-shadow:inset 0 2px 7px rgba(0,0,0,.22)!important;",
      "  opacity:1!important;",
      "  border-radius:50%!important;",
      "}"
    ].join("");
    document.head.appendChild(st);
  })();

  /* ================= 界面弹出动画 ================= */
  (function () {
    var st = document.createElement("style");
    st.textContent = [
      // 内容区：轻微放大 + 淡入，做出"界面被推出"的感觉
      // 只能用 opacity：一旦给 #root 加 transform/filter，内部的 fixed 元素
      // （语音输入面板、键盘联想条）会改以 #root 为基准，瞬间错位=闪一下
      "@keyframes __pop_in{from{opacity:.78}to{opacity:1}}",
      "#root.__pop{animation:__pop_in .18s cubic-bezier(.2,.9,.3,1)}",
      // 相机：从下往上滑入
      "@keyframes __cam_in{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}",
      "#__cam_view.on{animation:__cam_in .18s cubic-bezier(.2,.9,.3,1)}",
      // 预览页：淡入 + 轻微上浮
      "@keyframes __prev_in{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}",
      "#__cam_prev.on{animation:__prev_in .16s ease-out}",
      // 底部面板：改弹簧曲线，更有弹出手感
      ""
    ].join("");
    document.head.appendChild(st);
  })();

  // 点这三个入口时，让主界面有一次"被推出"的过渡
  document.addEventListener("click", function (e) {
    var t = e.target;
    if (!t || t.nodeType !== 1) return;
    var hit = t.closest("[aria-label='打开边栏'],[aria-label='上传文件']");
    if (!hit) return;
    var root = document.getElementById("root");
    if (!root) return;
    root.classList.remove("__pop");
    void root.offsetWidth;          // 强制重排，让动画能重播
    root.classList.add("__pop");
    setTimeout(function () { root.classList.remove("__pop"); }, 240);
  }, true);

  // 相机样式里带了附件红叉的覆盖规则，必须一开始就注入，
  // 否则只走「相册/文件」加图时永远到不了 buildCam()，红叉就不会出现
  injectCamCss();

  console.log("[camera.js] ready");
})();
