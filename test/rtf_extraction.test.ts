import { describe, expect, it } from 'vitest';
import { extractRtfText } from '../server/knowledge/rtf';

describe('RTF extraction', () => {
  it('extracts unicode text and paragraphs while ignoring tables', () => {
    const rtf = String.raw`{\rtf1\ansi{\fonttbl{\f0 Arial;}}{\colortbl;\red255\green0\blue0;}\uc1\u30693?\u35782?\par Lumi \b knowledge\b0 \line upload}`;
    expect(extractRtfText(rtf)).toBe('知识\nLumi knowledge\nupload');
  });

  it('keeps escaped braces and backslashes as plain text', () => {
    const rtf = String.raw`{\rtf1 literal \{value\} and path C:\\Lumi}`;
    expect(extractRtfText(rtf)).toBe('literal {value} and path C:\\Lumi');
  });
});
