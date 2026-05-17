import { screen } from './engine/screen.js';
import { Keyboard } from './engine/keyboard.js';
import { isatty } from 'node:tty';

const keyboard = new Keyboard();
process.stderr.write('isatty=' + isatty(0) + ' setRawMode=' + (typeof (process.stdin as any).setRawMode) + '\n');

screen.enter();
let input = '';
const lines: string[] = ['Press Ctrl+Q, Ctrl+O. Check stderr.', ''];

screen.onKey(buf => {
  const hex = buf.toString('hex');
  process.stderr.write('RAW ' + hex + ' "' + buf.toString() + '"\n');
  for (const k of keyboard.feed(buf)) {
    process.stderr.write('  KEY name="' + k.name + '" ctrl=' + k.ctrl + ' alt=' + k.alt + '\n');
    if (k.ctrl && k.name === 'q') { process.stderr.write('-> QUIT\n'); screen.exit(); process.exit(0); }
    if (k.ctrl && k.name === 'o') { process.stderr.write('-> SETTINGS\n'); }
    if (k.name === 'enter') { lines.push('> ' + input); input = ''; render(); return; }
    if (k.name === 'backspace') { if (input.length) input = input.slice(0,-1); render(); return; }
    if (k.sequence.length === 1 && k.sequence.charCodeAt(0) >= 32) { input += k.sequence; render(); }
  }
});

function render(): void {
  const W = process.stdout.columns ?? 80; const H = process.stdout.rows ?? 24;
  let o = '\x1b[2J\x1b[H';
  for (let i = 0; i < Math.min(lines.length, H-2); i++) o += '\x1b[' + (i+1) + ';1H' + lines[i].slice(0, W);
  o += '\x1b[' + (H-1) + ';1H' + '-'.repeat(W);
  o += '\x1b[' + H + ';1H> ' + input;
  process.stdout.write(o);
}
render();
