/**
 * Runs inside a real VS Code extension host:
 *   code --extensionDevelopmentPath=<vscode folder> --extensionTestsPath=<out/hosttest/index.js>
 * Verifies that the extension activates, registers its command and opens the manager as an editor tab.
 * The VS Code launcher detaches, so the result is also written to the file named by HOSTTEST_OUT.
 */
import * as fs from 'fs';
import * as vscode from 'vscode';

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export async function run(): Promise<void> {
  const out = process.env['HOSTTEST_OUT'];
  const log: string[] = [];
  const say = (m: string) => { log.push(m); console.log(m); };
  try {
    await checks(say);
    if (out) { fs.writeFileSync(out, log.join('\n') + '\nRESULT: PASS\n'); }
  } catch (ex: any) {
    if (out) { fs.writeFileSync(out, log.join('\n') + '\nRESULT: FAIL ' + (ex?.stack ?? ex) + '\n'); }
    throw ex;
  }
}

async function checks(say: (m: string) => void): Promise<void> {
  const ext = vscode.extensions.getExtension('DimitarTsenev.agent-plugin-manager');
  if (!ext) {
    throw new Error('Extension DimitarTsenev.agent-plugin-manager not found');
  }
  await ext.activate();
  if (!ext.isActive) {
    throw new Error('Extension did not activate');
  }
  say('activated');

  const commands = await vscode.commands.getCommands(true);
  if (!commands.includes('agentPluginManager.open')) {
    throw new Error('Command agentPluginManager.open is not registered');
  }
  say('command registered');

  await vscode.commands.executeCommand('agentPluginManager.open');
  let found = false;
  for (let i = 0; i < 30 && !found; i++) {
    found = vscode.window.tabGroups.all.some(g => g.tabs.some(t => t.label === 'Agent Plugin Manager'));
    if (!found) {
      await sleep(200);
    }
  }
  if (!found) {
    throw new Error('Editor tab "Agent Plugin Manager" did not open');
  }
  say('editor tab opened');

  // Running the command again must reuse the same tab.
  await vscode.commands.executeCommand('agentPluginManager.open');
  await sleep(500);
  const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs).filter(t => t.label === 'Agent Plugin Manager');
  if (tabs.length !== 1) {
    throw new Error('Expected exactly one manager tab, found ' + tabs.length);
  }
  say('single tab reused');
}
