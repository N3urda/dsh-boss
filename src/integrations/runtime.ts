import { accessSync, constants, readFileSync } from 'node:fs';
import { delimiter, dirname, join, isAbsolute } from 'node:path';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';

function savedRuntime(): { mcpBin?: string; dataDir?: string } {
  try {
    const value = JSON.parse(readFileSync(dshHomePath('dsh-boss', 'connection.json'), 'utf8'));
    if (
      typeof value.mcpBin === 'string' &&
      isAbsolute(value.mcpBin) &&
      typeof value.dataDir === 'string' &&
      isAbsolute(value.dataDir)
    )
      return { mcpBin: value.mcpBin, dataDir: value.dataDir };
  } catch {}
  return {};
}
export function bossBinary() {
  return process.env.DSH_BOSS_MCP_BIN || savedRuntime().mcpBin || 'boss-mcp';
}
export function bossDataDir() {
  return process.env.DSH_BOSS_DATA_DIR || savedRuntime().dataDir || dshHomePath('dsh-boss', 'boss');
}
export function bossPython() {
  const configured = bossBinary();
  const paths =
    configured && configured !== 'boss-mcp'
      ? [dirname(configured)]
      : (process.env.PATH || '').split(delimiter).filter(Boolean);
  for (const path of paths) {
    try {
      accessSync(
        join(path, process.platform === 'win32' ? 'boss-mcp.exe' : 'boss-mcp'),
        constants.X_OK,
      );
      const python = join(path, process.platform === 'win32' ? 'python.exe' : 'python');
      accessSync(python, constants.X_OK);
      return python;
    } catch {}
  }
}
