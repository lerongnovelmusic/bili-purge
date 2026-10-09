/**
 * Double-click launcher for the console.
 *
 * start.cmd is a thin wrapper around this, so the whole thing can also be run by
 * hand with `node tools/launch.mjs` when something goes wrong. The checks and
 * the messages live here rather than in the .cmd because cmd echoing Chinese is
 * unreliable, while JavaScript writes UTF-8 correctly everywhere.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const say = (line = '') => process.stdout.write(line + String.fromCharCode(10));

// Set from here rather than from the .cmd, so the Chinese name survives.
process.title = 'B站清理助手';

/**
 * Put a shortcut on the desktop the first time this runs.
 *
 * Nobody should have to go digging for tools/make-shortcut.ps1, and a desktop
 * icon is what makes the tool feel installed rather than unpacked. Best effort
 * throughout: a machine without PowerShell still gets a working console.
 */
function ensureDesktopShortcut() {
  if (process.platform !== 'win32') return;

  const name = 'B站清理助手.lnk';
  const desktops = [
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, 'Desktop'),
    process.env.OneDrive && path.join(process.env.OneDrive, 'Desktop'),
    process.env.OneDriveConsumer && path.join(process.env.OneDriveConsumer, 'Desktop'),
  ].filter(Boolean);

  // The desktop can be redirected somewhere unguessable, so this is only a
  // cheap "probably already done" test. The script resolves the real folder and
  // leaves an existing, correct shortcut alone.
  if (desktops.some((dir) => fs.existsSync(path.join(dir, name)))) return;

  const script = path.join(root, 'tools', 'make-shortcut.ps1');
  if (!fs.existsSync(script)) return;

  try {
    spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
      cwd: root,
      stdio: 'inherit',
    });
  } catch {
    say('  （桌面快捷方式没建成，不影响使用）');
  }
}

// `import.meta.dirname` already requires 20.11, but say so plainly if someone
// runs an older Node that got this far.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && minor < 11)) {
  say();
  say(`  你的 Node.js 版本太旧了：${process.versions.node}`);
  say('  需要 20.11 或更新版本，请到 https://nodejs.org/ 升级。');
  say();
  process.exit(1);
}

if (!fs.existsSync(path.join(root, 'node_modules', 'qrcode'))) {
  say('  第一次运行，正在安装依赖...');
  say();
  const installed = spawnSync('npm install --no-audit --no-fund', {
    cwd: root,
    stdio: 'inherit',
    shell: true,
  });
  if (installed.status !== 0) {
    say();
    say('  依赖安装失败。');
    say('  最常见的原因是连不上 npm，可以换国内镜像后重试：');
    say('      npm config set registry https://registry.npmmirror.com');
    say();
    process.exit(1);
  }
  say();
}

say('  B站清理助手');
say('  ----------------------------------------');
ensureDesktopShortcut();
say('  正在启动，浏览器会自动打开。');
say('  用完之后，直接关掉这个窗口就停止了。');
say();

const child = spawn(process.execPath, [path.join(root, 'gui.js'), '--open'], {
  cwd: root,
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 0));
