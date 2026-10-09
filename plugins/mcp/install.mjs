#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from './server.mjs';

const args = process.argv.slice(2);
if (args[0] !== '--config' || !args[1] || !args.slice(2).length || args.slice(2).some(a => !['--codex','--cursor'].includes(a))) {
  console.error('Usage: node install.mjs --config /private/config.json --codex --cursor');
  process.exit(1);
}
const path = resolve(args[1]);
const serverPath = fileURLToPath(new URL('./server.mjs',import.meta.url));
// Validate credentials, the user and every configured space before registering.
const server = await createServer(JSON.parse(await readFile(path,'utf8')));
await server.close();
if (args.includes('--codex')) {
  const result = spawnSync('codex',['mcp','add','scratchwall','--',process.execPath,serverPath,'--config',path],{stdio:'inherit'});
  if (result.error || result.status !== 0) throw new Error('Codex registration failed; ensure the codex CLI is installed');
}
if (args.includes('--cursor')) {
  const file = resolve(homedir(),'.cursor','mcp.json');
  await mkdir(dirname(file),{recursive:true});
  let config = {}, previous;
  try { previous = await readFile(file,'utf8'); config = JSON.parse(previous); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (previous) await writeFile(`${file}.backup-${Date.now()}`,previous,{mode:0o600});
  config.mcpServers ??= {};
  config.mcpServers.scratchwall = {type:'stdio',command:process.execPath,args:[serverPath,'--config',path]};
  await writeFile(file,JSON.stringify(config,null,2)+'\n',{mode:0o600});
  console.log('Registered Scratchwall in Cursor');
}
