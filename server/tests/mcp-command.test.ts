import { describe, it, expect } from 'vitest';
import { isAllowedMcpCommand } from '../src/validators/mcp-command.js';

describe('isAllowedMcpCommand（D-05 MCP command 白名单）', () => {
  // ── 正常例（绿）──
  it.each(['node', 'npx', 'uvx', 'uv', 'npm', 'pnpm', 'bun', 'python', 'python3'])(
    '允许受信任运行时 %s',
    (cmd) => {
      expect(isAllowedMcpCommand(cmd).ok).toBe(true);
    },
  );

  it('允许绝对路径的自定义可执行文件（非拒绝 basename）', () => {
    expect(isAllowedMcpCommand('C:\\tools\\my-mcp-server.exe').ok).toBe(true);
    expect(isAllowedMcpCommand('/usr/local/bin/my-mcp-server').ok).toBe(true);
  });

  // ── 破坏夹具（红）──
  it('拒绝把 shell 解释器当 command（cmd/powershell/bash/pwsh/sh/wsl）', () => {
    for (const cmd of ['cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'bash', 'sh', 'wsl', 'wsl.exe']) {
      expect(isAllowedMcpCommand(cmd).ok, `${cmd} 必须被拒绝`).toBe(false);
    }
  });

  it('拒绝 Windows LOLBin（cscript/wscript/mshta/rundll32/regsvr32/certutil）', () => {
    for (const cmd of ['cscript.exe', 'wscript', 'mshta', 'rundll32', 'regsvr32.exe', 'certutil.exe']) {
      expect(isAllowedMcpCommand(cmd).ok, `${cmd} 必须被拒绝`).toBe(false);
    }
  });

  it('拒绝绝对路径下的危险解释器（C:\\Windows\\System32\\cmd.exe）', () => {
    expect(isAllowedMcpCommand('C:\\Windows\\System32\\cmd.exe').ok).toBe(false);
    expect(isAllowedMcpCommand('/bin/bash').ok).toBe(false);
  });

  it('拒绝 shell 元字符（& | > < ^ % ; 空格）', () => {
    for (const cmd of ['node && whoami', 'a;b', 'foo bar', 'a|b', 'a>b', 'a%b']) {
      expect(isAllowedMcpCommand(cmd).ok, `${cmd} 必须被拒绝`).toBe(false);
    }
  });

  it('拒绝空命令与裸未知命令（fail-closed：非白名单非绝对路径一律拒绝）', () => {
    expect(isAllowedMcpCommand('').ok).toBe(false);
    expect(isAllowedMcpCommand('   ').ok).toBe(false);
    expect(isAllowedMcpCommand('my-unknown-server').ok).toBe(false); // 裸未知命令：要求绝对路径
  });

  it('拒绝大小写变体的危险解释器（basename 小写归一）', () => {
    expect(isAllowedMcpCommand('C:\\Windows\\System32\\CMD.EXE').ok).toBe(false);
    expect(isAllowedMcpCommand('PowerShell.exe').ok).toBe(false);
  });
});