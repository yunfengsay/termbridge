import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
export async function runBrowser(args: string[]): Promise<void> {
  const here=dirname(fileURLToPath(import.meta.url));
  const entry=[resolve(here,'browser-extension/bridge.mjs'),resolve(here,'../../../browser-extension/bridge.mjs')].find(existsSync);
  if(!entry)throw new Error('Chrome component is missing; reinstall TermBridge.');
  const child=spawn(process.execPath,[entry,...args],{stdio:'inherit',windowsHide:true});
  const code=await new Promise<number>((ok,fail)=>{child.once('error',fail);child.once('exit',c=>ok(c??1));});
  if(code)process.exitCode=code;
}
