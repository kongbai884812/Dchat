#!/usr/bin/env node
/**
 * 零依赖：静态站点 + DeepSeek 接口代理
 *   node server/proxy.mjs
 * 环境变量见 .env.example
 *
 * 作用：把密钥留在服务端，前端只请求 /api/chat。
 * 这样既绕开浏览器直连 api.deepseek.com 的 CORS 问题，也不会把 key 打进 APK。
 */
import http from "node:http";
import https from "node:https";
import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ---------- 极简 .env 加载（不引入 dotenv） ----------
async function loadEnv() {
  try {
    const txt = await readFile(path.join(ROOT, ".env"), "utf8");
    for (const raw of txt.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const i = line.indexOf("=");
      if (i < 0) continue;
      const k = line.slice(0, i).trim();
      let v = line.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch { /* 没有 .env 也照跑 */ }
}

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

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "600",
  };
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

async function serveStatic(req, res, urlPath) {
  // 防目录穿越
  const rel = decodeURIComponent(urlPath.split("?")[0]);
  let file = path.join(ROOT, "www", rel === "/" ? "index.html" : rel);
  if (!file.startsWith(path.join(ROOT, "www"))) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    let s = await stat(file);
    if (s.isDirectory()) {
      file = path.join(file, "index.html");
      s = await stat(file);
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Content-Length": s.size,
      "Cache-Control": "no-cache",
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("404 " + rel);
  }
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function proxyChat(req, res, origin) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) {
    sendJson(res, 500, { error: { message: "服务端没有配置 DEEPSEEK_API_KEY（在 .env 里填）" } });
    return;
  }

  readBody(req).then((buf) => {
    let payload;
    try { payload = JSON.parse(buf.toString("utf8") || "{}"); }
    catch { sendJson(res, 400, { error: { message: "请求体不是合法 JSON" } }); return; }

    if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
      sendJson(res, 400, { error: { message: "messages 不能为空" } });
      return;
    }
    const body = JSON.stringify({
      model: payload.model || process.env.DEEPSEEK_MODEL || "deepseek-chat",
      messages: payload.messages.slice(-40),
      stream: payload.stream !== false,
      temperature: typeof payload.temperature === "number" ? payload.temperature : 1,
    });

    const upstream = https.request(
      {
        hostname: "api.deepseek.com",
        path: "/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Authorization: "Bearer " + key,
          Accept: "text/event-stream",
        },
      },
      (up) => {
        const ct = up.headers["content-type"] || "text/event-stream";
        res.writeHead(up.statusCode || 502, Object.assign({
          "Content-Type": ct,
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          Connection: "keep-alive",
        }, corsHeaders(origin)));
        up.pipe(res);
      }
    );

    upstream.setTimeout(180000, () => upstream.destroy(new Error("upstream timeout")));
    upstream.on("error", (e) => {
      if (!res.headersSent) sendJson(res, 502, { error: { message: "上游请求失败：" + e.message } });
      else res.end();
    });
    upstream.end(body);
  }).catch((e) => {
    if (!res.headersSent) sendJson(res, 400, { error: { message: e.message } });
  });
}

async function main() {
  await loadEnv();
  const PORT = Number(process.env.PORT || 8080);
  const HOST = process.env.HOST || "127.0.0.1";

  const server = http.createServer((req, res) => {
    const origin = req.headers.origin || "";
    const url = req.url || "/";

    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders(origin)).end();
      return;
    }
    if (url.startsWith("/api/chat")) {
      if (req.method !== "POST") { sendJson(res, 405, { error: { message: "只接受 POST" } }); return; }
      proxyChat(req, res, origin);
      return;
    }
    if (url.startsWith("/api/health")) {
      sendJson(res, 200, {
        ok: true,
        key: process.env.DEEPSEEK_API_KEY ? "configured" : "missing",
        model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
      });
      return;
    }
    serveStatic(req, res, url);
  });

  server.listen(PORT, HOST, () => {
    const keyState = process.env.DEEPSEEK_API_KEY ? "已配置" : "缺失（聊天会返回 500）";
    console.log(`\n  Dchat 本地服务`);
    console.log(`  页面      http://${HOST}:${PORT}/`);
    console.log(`  诊断页    http://${HOST}:${PORT}/diag.html`);
    console.log(`  代理接口  POST http://${HOST}:${PORT}/api/chat`);
    console.log(`  API Key   ${keyState}\n`);
    if (HOST === "0.0.0.0") console.log("  ⚠ 已监听 0.0.0.0，同网段的人都能用你的额度，仅调试时这样开\n");
  });
}

main();