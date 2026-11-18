#!/usr/bin/env node
/**
 * 零依赖静态预览服务：把 www/ 当普通网站跑起来
 *   node server/proxy.mjs          → http://127.0.0.1:8080
 *   HOST=0.0.0.0 PORT=9000 node server/proxy.mjs
 *
 * 只是给电脑上验页面用的（页面必须跑在 http(s) 下，file:// 会废掉动态 import）。
 * 聊天请求由前端直连 api.deepseek.com，不经过这里，也不需要服务端存 key。
 */
import http from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WWW = path.join(ROOT, "www");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

async function serve(urlPath, res) {
  const rel = decodeURIComponent(urlPath.split("?")[0]);
  let file = path.join(WWW, rel === "/" ? "index.html" : rel);
  if (!file.startsWith(WWW)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    let info = await stat(file);
    if (info.isDirectory()) {
      file = path.join(file, "index.html");
      info = await stat(file);
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Content-Length": info.size,
      "Cache-Control": "no-cache",
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("404 " + rel);
  }
}

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "127.0.0.1";

http
  .createServer((req, res) => {
    void serve(req.url || "/", res);
  })
  .listen(PORT, HOST, () => {
    console.log(`\n  Dchat 本地预览`);
    console.log(`  页面    http://${HOST}:${PORT}/`);
    console.log(`  诊断页  http://${HOST}:${PORT}/diag.html\n`);
    if (HOST === "0.0.0.0") console.log("  ⚠ 已监听 0.0.0.0，同网段可访问\n");
  });
