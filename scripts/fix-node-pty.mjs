// node-pty 的预编译 spawn-helper 在部分安装方式下缺少可执行权限，会导致 posix_spawnp failed
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

try {
  const require = createRequire(path.resolve('apps/server/package.json'));
  const root = path.dirname(require.resolve('node-pty/package.json'));
  const dir = path.join(root, 'prebuilds');
  for (const p of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const helper = path.join(dir, p, 'spawn-helper');
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
  }
} catch (e) {
  console.warn('[fix-node-pty] 跳过：', e.message);
}
