/* 诊断浮层：入口是 React 侧的 DiagButton（顶栏右上角），这里只负责全屏 iframe。
   挂到 window 上，diag.html 里的「返回」会调用 parent.__closeDiag() 收起浮层。 */
;(function () {
  var overlay = null
  var frame = null
  var loaded = false

  function buildOverlay() {
    overlay = document.createElement('div')
    overlay.id = '__diag_overlay'
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:2147483646;background:#0f1115;' +
      'display:flex;flex-direction:column;transform:translateY(100%);' +
      'transition:transform .18s ease-out;will-change:transform'

    frame = document.createElement('iframe')
    frame.setAttribute('allow', 'clipboard-write')
    frame.style.cssText = 'flex:1;width:100%;border:0;background:#0f1115'
    overlay.appendChild(frame)
    document.body.appendChild(overlay)

    frame.addEventListener('load', function () {
      loaded = true
    })
  }

  function openDiag() {
    try {
      window.NativeShell && window.NativeShell.setModal(1)
    } catch (e) {}
    if (!overlay) buildOverlay()
    if (!loaded) frame.src = 'diag.html'
    overlay.style.display = 'flex'
    requestAnimationFrame(function () {
      overlay.style.transform = 'translateY(0)'
    })
  }

  function closeDiag() {
    try {
      window.NativeShell && window.NativeShell.setModal(0)
    } catch (e) {}
    if (!overlay) return
    overlay.style.transform = 'translateY(100%)'
    setTimeout(function () {
      overlay.style.display = 'none'
    }, 180)
  }

  window.__openDiag = openDiag
  window.__closeDiag = closeDiag
})()

// ---- 界面自检：把关键元素的位置/遮挡情况打到 logcat（tag: DchatWeb），便于远程排查 ----
;(function () {
  function rect(r) {
    return r
      ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)].join(',')
      : '-'
  }

  var run = 0

  function probe() {
    run++
    try {
      var meta = document.querySelector('meta[name="application-version"]')
      var sel = '[aria-label="语音输入"],[aria-label="Voice input"]'
      var all = document.querySelectorAll(sel)
      var mic = all[0]
      var out = ['[dchat-ui] ver=' + (meta ? meta.content : '?')]
      out.push('vp=' + window.innerWidth + 'x' + window.innerHeight + '@' + window.devicePixelRatio)
      out.push('mic=' + (mic ? 'yes' : 'no') + ' count=' + all.length)
      if (mic) {
        var r = mic.getBoundingClientRect()
        // 无论是否在屏幕内都要打：祖先链 + 自身 outerHTML
        var chain = []
        var cur = mic
        while (cur && cur !== document.body && chain.length < 8) {
          var st2 = getComputedStyle(cur)
          chain.push(
            cur.tagName +
              '.' +
              (cur.className || '-') +
              (cur.hidden ? '[hidden]' : '') +
              '{' +
              st2.display +
              '}'
          )
          cur = cur.parentElement
        }
        // 找出到底是哪条 CSS 规则把它设成 display:none
        var hits = []
        ;(function scan(list, prefix) {
          for (var i = 0; i < list.length; i++) {
            var rule = list[i]
            try {
              if (rule.cssRules) {
                var cond = rule.conditionText || (rule.media && rule.media.mediaText) || ''
                scan(rule.cssRules, prefix + cond + ' >> ')
                continue
              }
              if (!rule.selectorText || !rule.style || !rule.style.display) continue
              if (!mic.matches(rule.selectorText)) continue
              hits.push(
                prefix +
                  rule.selectorText +
                  ' => ' +
                  rule.style.display +
                  (rule.style.getPropertyPriority('display') ? '!' : '')
              )
            } catch (e) {}
          }
        })(document.styleSheets, '')
        var sheetCount = 0
        for (var si = 0; si < document.styleSheets.length; si++) {
          try {
            document.styleSheets[si].cssRules
            sheetCount++
          } catch (e) {}
        }
        out.push('sheets=' + document.styleSheets.length + '/' + sheetCount)
        out.push('css=' + (hits.length ? hits.join(' || ') : 'no-match'))
        out.push(
          'inline=' + (mic.style.display || '-') + ' attr_hidden=' + mic.hasAttribute('hidden')
        )
        if (getComputedStyle(mic).display === 'none') {
          // 就地强制显示，验证是不是纯 CSS 级联问题
          mic.style.setProperty('display', 'inline-flex', 'important')
          var r2 = mic.getBoundingClientRect()
          out.push('forced=' + getComputedStyle(mic).display + ' rect2=' + rect(r2))
        }
        out.push('chain=' + chain.join(' < '))
        out.push('html=' + String(mic.outerHTML).slice(0, 220))
        var cs = getComputedStyle(mic)
        out.push('rect=' + rect(r))
        out.push(
          'display=' +
            cs.display +
            ',vis=' +
            cs.visibility +
            ',op=' +
            cs.opacity +
            ',pos=' +
            cs.position +
            ',z=' +
            cs.zIndex
        )
        out.push('parent=' + (mic.parentElement ? mic.parentElement.className : '-'))
        var cx = r.x + r.width / 2
        var cy = r.y + r.height / 2
        if (cx > 0 && cy > 0 && cx < window.innerWidth && cy < window.innerHeight) {
          var top = document.elementFromPoint(cx, cy)
          out.push(
            'hit=' +
              (top === mic || mic.contains(top)
                ? 'self'
                : top
                  ? top.tagName + '.' + top.className
                  : 'null')
          )
          // 往上追溯，看是哪一层被隐藏/裁掉
        } else {
          out.push('hit=offscreen')
        }
      }
      var report = out.join('\n')
      console.log(report.replace(/\n/g, ' '))
      try {
        // 同时落盘，日志被刷掉也能读到
        window.NativeShell &&
          window.NativeShell.dumpText &&
          window.NativeShell.dumpText('dchat-ui-' + run + '.txt', report)
      } catch (e) {}
    } catch (e) {
      console.log('[dchat-ui] probe fail: ' + e)
    }
  }

  window.addEventListener('error', function (e) {
    console.log('[dchat-ui] js-error: ' + (e && e.message))
  })

  setTimeout(probe, 3000)
  setTimeout(probe, 8000)
  var timer = 0
  window.addEventListener('resize', function () {
    clearTimeout(timer)
    timer = setTimeout(probe, 600)
  })
})()
