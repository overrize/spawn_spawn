import { ParsedKey, Keybinding, KeyAction } from './types.js';

export class Keyboard {
  private buf = '';

  feed(buf: Buffer): ParsedKey[] {
    this.buf += buf.toString('utf8');
    const keys: ParsedKey[] = [];

    while (this.buf.length > 0) {
      const result = this.parseOne(this.buf);
      if (!result) break;
      keys.push(result.key);
      this.buf = this.buf.slice(result.consumed);
    }

    return keys;
  }

  private parseOne(input: string): { key: ParsedKey; consumed: number } | null {
    if (input.length === 0) return null;
    const code = input.charCodeAt(0);

    if (code === 0x1b) {
      if (input.length === 1) return null;
      const seq = input.slice(1);

      if (seq === '') return null;

      if (seq[0] === '[') {
        if (seq.length >= 2 && seq[1] === '<') {
          const m = seq.match(/^\[<\d+;\d+;\d+[Mm]/);
          if (m) {
            const parts = m[0].slice(2, -1).split(';');
            const btn = parseInt(parts[0]);
            if (btn === 64) return { key: this.makeKey('scrollup', false, false, false, ''), consumed: 1 + m[0].length };
            if (btn === 65) return { key: this.makeKey('scrolldown', false, false, false, ''), consumed: 1 + m[0].length };
            return { key: this.makeKey('mouse', false, false, false, ''), consumed: 1 + m[0].length };
          }
          return null;
        }
        const match = seq.match(/^\[(\d+)?(;(\d+))?([ABCDEFGHJKLMNOPQRSTUVWXYZ~])/);
        if (!match) {
          if (seq.length >= 1 && seq[0] >= 'A' && seq[0] <= 'D') {
            const dirMap: Record<string, string> = { A: 'up', B: 'down', C: 'right', D: 'left' };
            return { key: this.makeKey(dirMap[seq[0]], false, false, false, `\x1b[${seq[0]}`), consumed: 3 };
          }
          return { key: this.makeKey('escape', false, false, false, '\x1b'), consumed: 1 };
        }

        const param = match[1] ? parseInt(match[1]) : 1;
        const mod = match[3] ? parseInt(match[3]) : 0;
        const final = match[4];

        const ctrl = (mod & 4) !== 0 || (mod & 5) !== 0;
        const alt = (mod & 2) !== 0 || (mod & 3) !== 0 || (mod & 9) !== 0;
        const shift = (mod & 1) !== 0;

        if (final === '~') {
          const fMap: Record<number, string> = { 1: 'home', 2: 'insert', 3: 'delete', 4: 'end', 5: 'pageup', 6: 'pagedown' };
          const name = fMap[param] ?? `f${param - 10}`;
          return { key: this.makeKey(name, ctrl, alt, shift, `\x1b[${param}~`), consumed: 2 + match[0].length };
        }

        if (final === 'H') return { key: this.makeKey('home', ctrl, alt, shift, `\x1b[${match[0]}`), consumed: 2 + match[0].length };
        if (final === 'F') return { key: this.makeKey('end', ctrl, alt, shift, `\x1b[${match[0]}`), consumed: 2 + match[0].length };
        if (final === 'A') return { key: this.makeKey('up', ctrl, alt, shift, `\x1b[${match[0]}`), consumed: 2 + match[0].length };
        if (final === 'B') return { key: this.makeKey('down', ctrl, alt, shift, `\x1b[${match[0]}`), consumed: 2 + match[0].length };
        if (final === 'C') return { key: this.makeKey('right', ctrl, alt, shift, `\x1b[${match[0]}`), consumed: 2 + match[0].length };
        if (final === 'D') return { key: this.makeKey('left', ctrl, alt, shift, `\x1b[${match[0]}`), consumed: 2 + match[0].length };
        if (final === 'Z') return { key: this.makeKey('tab', false, false, true, `\x1b[Z`), consumed: 3 };

        return null;
      }

      if (seq[0] === 'O') {
        const fMap: Record<string, string> = {
          P: 'f1', Q: 'f2', R: 'f3', S: 'f4',
          H: 'home', F: 'end',
        };
        if (fMap[seq[1]]) {
          return { key: this.makeKey(fMap[seq[1]], false, false, false, `\x1bO${seq[1]}`), consumed: 3 };
        }
      }

      if (seq.length >= 1 && seq[0] >= 'a' && seq[0] <= 'z') {
        return { key: this.makeKey(seq[0], false, true, false, `\x1b${seq[0]}`), consumed: 2 };
      }

      return { key: this.makeKey('escape', false, false, false, '\x1b'), consumed: 1 };
    }

    if (code === 13) {
      return { key: this.makeKey('enter', false, false, false, '\r'), consumed: 1 };
    }

    if (code === 10) {
      return { key: this.makeKey('enter', false, false, false, '\n'), consumed: 1 };
    }

    if (code >= 1 && code <= 26) {
      const letter = String.fromCharCode(code + 96);
      return { key: this.makeKey(letter, true, false, false, input[0]), consumed: 1 };
    }

    if (code === 127 || code === 8) {
      return { key: this.makeKey('backspace', false, false, false, input[0]), consumed: 1 };
    }

    if (code === 9) {
      return { key: this.makeKey('tab', false, false, false, '\t'), consumed: 1 };
    }

    if (code === 32) {
      return { key: this.makeKey('space', false, false, false, ' '), consumed: 1 };
    }

    if (code >= 32 && code <= 126) {
      return { key: this.makeKey(input[0], false, false, false, input[0]), consumed: 1 };
    }

    if (code > 126) {
      return { key: this.makeKey(input[0], false, false, false, input[0]), consumed: 1 };
    }

    return { key: this.makeKey('unknown', false, false, false, input[0]), consumed: 1 };
  }

  private makeKey(name: string, ctrl: boolean, alt: boolean, shift: boolean, sequence: string): ParsedKey {
    return { name: name.toLowerCase(), ctrl, alt, shift, meta: false, sequence };
  }
}

export class KeybindingRegistry {
  private bindings: Keybinding[] = [];
  private seqBuf: ParsedKey[] = [];

  register(bindings: Keybinding[]): void {
    this.bindings.push(...bindings);
  }

  match(key: ParsedKey): KeyAction | null {
    this.seqBuf.push(key);

    for (const binding of this.bindings) {
      const parts = binding.key.split(' ');

      if (parts.length > this.seqBuf.length) continue;

      const recent = this.seqBuf.slice(-parts.length);
      let match = true;
      for (let i = 0; i < parts.length; i++) {
        if (!this.keyMatches(recent[i], parts[i])) {
          match = false;
          break;
        }
      }
      if (match) {
        this.seqBuf = [];
        return binding.action;
      }
    }

    if (this.seqBuf.length > 3) this.seqBuf = [];
    return null;
  }

  getBindings(): Keybinding[] {
    return this.bindings;
  }

  private keyMatches(key: ParsedKey, spec: string): boolean {
    const s = spec.toLowerCase();

    if (s === 'escape' && key.name === 'escape') return true;
    if (s === 'enter' && key.name === 'enter') return true;
    if (s === 'tab' && key.name === 'tab') return true;
    if (s === 'backspace' && key.name === 'backspace') return true;
    if (s === 'space' && (key.name === 'space' || key.sequence === ' ')) return true;
    if (s === 'up' && key.name === 'up') return true;
    if (s === 'down' && key.name === 'down') return true;
    if (s === 'left' && key.name === 'left') return true;
    if (s === 'right' && key.name === 'right') return true;
    if (s === 'home' && key.name === 'home') return true;
    if (s === 'end' && key.name === 'end') return true;
    if (s === 'pageup' && key.name === 'pageup') return true;
    if (s === 'pagedown' && key.name === 'pagedown') return true;

    const parts = s.split('+');
    if (parts.length > 1) {
      const ctrl = parts.includes('ctrl');
      const alt = parts.includes('alt');
      const shift = parts.includes('shift');
      if (ctrl !== key.ctrl) return false;
      if (alt !== key.alt) return false;
      if (shift !== key.shift) return false;

      const ch = parts[parts.length - 1];
      return ch.length === 1 && key.name === ch;
    }

    return s.length === 1 && key.name === s && !key.ctrl && !key.alt && !key.shift;
  }
}
