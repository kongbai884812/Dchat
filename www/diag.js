/* 诊断浮层：入口是 React 侧的 DiagButton（顶栏右上角），这里只负责全屏 iframe。
   挂到 window 上，diag.html 里的「返回」会调用 parent.__closeDiag() 收起浮层。 */
(function () {
  var overlay = null;
  var frame = null;
  var loaded = false;

  function buildOverlay() {
    overlay = document.createElement("div");
    overlay.id = "__diag_overlay";
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:2147483646;background:#0f1115;" +
      "display:flex;flex-direction:column;transform:translateY(100%);" +
      "transition:transform .18s ease-out;will-change:transform";

    frame = document.createElement("iframe");
    frame.setAttribute("allow", "clipboard-write");
    frame.style.cssText = "flex:1;width:100%;border:0;background:#0f1115";
    overlay.appendChild(frame);
    document.body.appendChild(overlay);

    frame.addEventListener("load", function () {
      loaded = true;
    });
  }

  function openDiag() {
    try {
      window.NativeShell && window.NativeShell.setModal(1);
    } catch (e) {}
    if (!overlay) buildOverlay();
    if (!loaded) frame.src = "diag.html";
    overlay.style.display = "flex";
    requestAnimationFrame(function () {
      overlay.style.transform = "translateY(0)";
    });
  }

  function closeDiag() {
    try {
      window.NativeShell && window.NativeShell.setModal(0);
    } catch (e) {}
    if (!overlay) return;
    overlay.style.transform = "translateY(100%)";
    setTimeout(function () {
      overlay.style.display = "none";
    }, 180);
  }

  window.__openDiag = openDiag;
  window.__closeDiag = closeDiag;
})();
