const DESTINATION_CONTROL_WORDS = new Set([
  'fonttbl',
  'colortbl',
  'stylesheet',
  'info',
  'pict',
  'object',
  'xmlnstbl',
  'themedata',
  'datastore',
]);

interface RtfState {
  ignorable: boolean;
  ucSkip: number;
}

function decodeRtfUnicode(value: number): string {
  const code = value < 0 ? value + 65536 : value;
  return String.fromCharCode(code);
}

function decodeHexByte(hex: string): string {
  const value = Number.parseInt(hex, 16);
  if (!Number.isFinite(value)) return '';
  return Buffer.from([value]).toString('latin1');
}

export function extractRtfText(rtf: string): string {
  const stack: RtfState[] = [{ ignorable: false, ucSkip: 1 }];
  let output = '';
  let index = 0;
  let pendingIgnorableDestination = false;

  const current = () => stack[stack.length - 1];
  const append = (value: string) => {
    if (!current().ignorable) output += value;
  };

  while (index < rtf.length) {
    const char = rtf[index];

    if (char === '{') {
      stack.push({ ...current(), ignorable: pendingIgnorableDestination || current().ignorable });
      pendingIgnorableDestination = false;
      index++;
      continue;
    }

    if (char === '}') {
      if (stack.length > 1) stack.pop();
      pendingIgnorableDestination = false;
      index++;
      continue;
    }

    if (char !== '\\') {
      append(char);
      index++;
      continue;
    }

    const next = rtf[index + 1];
    if (next === '\\' || next === '{' || next === '}') {
      append(next);
      index += 2;
      continue;
    }

    if (next === '~') {
      append(' ');
      index += 2;
      continue;
    }

    if (next === '-' || next === '_') {
      append('-');
      index += 2;
      continue;
    }

    if (next === '*') {
      pendingIgnorableDestination = true;
      index += 2;
      continue;
    }

    if (next === "'") {
      append(decodeHexByte(rtf.slice(index + 2, index + 4)));
      index += 4;
      continue;
    }

    const match = rtf.slice(index + 1).match(/^([a-zA-Z]+)(-?\d+)? ?/);
    if (!match) {
      index += 2;
      continue;
    }

    const word = match[1];
    const parameter = match[2] !== undefined ? Number(match[2]) : undefined;
    index += 1 + match[0].length;

    if (DESTINATION_CONTROL_WORDS.has(word)) {
      current().ignorable = true;
      continue;
    }

    switch (word) {
      case 'uc':
        if (parameter !== undefined) current().ucSkip = Math.max(0, parameter);
        break;
      case 'u':
        if (parameter !== undefined) {
          append(decodeRtfUnicode(parameter));
          index += current().ucSkip;
        }
        break;
      case 'par':
      case 'line':
        append('\n');
        break;
      case 'tab':
        append('\t');
        break;
      default:
        break;
    }
  }

  return output
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
