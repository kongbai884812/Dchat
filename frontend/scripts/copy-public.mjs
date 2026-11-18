// 壳补丁：这些文件原样拷进 dist，不经过打包器（保证与仓库内文件字节一致）
import { copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
for (const name of ['camera.js', 'diag.js', 'diag.html', 'zipcheck.html']) {
  copyFileSync(resolve(root, 'public', name), resolve(root, 'dist', name))
}
