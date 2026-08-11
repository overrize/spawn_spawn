#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

const logFile = path.resolve(process.cwd(), 'tui.log');

const args = new Set(process.argv.slice(2));
if (args.has('--help') || args.has('-h')) {
  process.stdout.write(`Usage: npm run log:tail -- [--history] [--bytes=N]\n\n`);
  process.stdout.write(`Default: follow only new tui.log output from now.\n`);
  process.stdout.write(`  --history   print recent existing log content before following\n`);
  process.stdout.write(`  --bytes=N   history bytes to print with --history (default 8192)\n`);
  process.exit(0);
}

const bytesArg = process.argv.slice(2).find((arg) => arg.startsWith('--bytes='));
const initBytes = bytesArg ? Number(bytesArg.slice('--bytes='.length)) : 8192;
const printHistory = args.has('--history');
let pos = 0;

try {
  const stat = fs.statSync(logFile);
  pos = printHistory ? Math.max(0, stat.size - Math.max(0, initBytes || 0)) : stat.size;
} catch {
  // file doesn't exist yet — start from 0
}

function flush() {
  try {
    const stat = fs.statSync(logFile);
    if (stat.size < pos) pos = 0; // file was rotated/truncated
    if (stat.size <= pos) return;
    const fd = fs.openSync(logFile, 'r');
    const len = stat.size - pos;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, pos);
    fs.closeSync(fd);
    pos = stat.size;
    process.stdout.write(buf.toString('utf8'));
  } catch { /* ignore read errors */ }
}

if (printHistory) flush(); // print tail of existing content only when requested

fs.watchFile(logFile, { interval: 200 }, flush);

process.stdout.write(`[watching tui.log from ${printHistory ? 'recent history' : 'now'} — Ctrl+C to stop]\n`);
