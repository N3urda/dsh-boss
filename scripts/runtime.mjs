import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
const root = fileURLToPath(new URL('../', import.meta.url));
const bin = join(root, '.runtime', process.platform === 'win32' ? 'Scripts' : 'bin');
const bossData = process.env.DSH_BOSS_DATA_DIR || join(root, '.local', 'boss');
const run = (command, args, env = process.env) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', env });
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`${command} stopped (${signal || code})`)),
    );
  });
try {
  const mode = process.argv[2];
  if (mode === 'setup') {
    await run('uv', ['venv', '.runtime', '--python', '3.12']);
    await run('uv', [
      'pip',
      'install',
      '--python',
      join(bin, 'python'),
      '-r',
      'scripts/boss-requirements.txt',
    ]);
  } else if (mode === 'login') {
    if (!existsSync(join(bin, 'python'))) throw new Error('请先执行 npm run boss:setup');
    mkdirSync(bossData, { recursive: true, mode: 0o700 });
    await run(join(bin, 'python'), ['scripts/boss-login.py', bossData]);
  } else if (mode === 'start') {
    if (!existsSync(join(bin, 'boss-mcp'))) throw new Error('请先执行 npm run boss:setup');
    // Store only local runtime paths so a later plain `dsh web` can also offer inline QR login.
    const configDir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-boss');
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const configFile = join(configDir, 'connection.json');
    const temporary = `${configFile}.${process.pid}.tmp`;
    writeFileSync(
      temporary,
      JSON.stringify({ mcpBin: join(bin, 'boss-mcp'), dataDir: resolve(bossData) }),
      { mode: 0o600 },
    );
    renameSync(temporary, configFile);
    chmodSync(configFile, 0o600);
    await run('dsh', ['web', ...process.argv.slice(3)], {
      ...process.env,
      DSH_BOSS_MCP_BIN: join(bin, 'boss-mcp'),
      DSH_BOSS_DATA_DIR: bossData,
    });
  } else throw new Error('Unknown mode');
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
