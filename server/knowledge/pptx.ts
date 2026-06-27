import fs from 'fs';

interface ZipEntryLike {
  name: string;
  dir: boolean;
  async(type: 'string'): Promise<string>;
}

interface PptxZipLike {
  files: Record<string, ZipEntryLike>;
}

function slideNumber(name: string): number {
  const match = name.match(/(?:slide|notesSlide)(\d+)\.xml$/i);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function collectTextRuns(xml: string): string[] {
  return Array.from(xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g))
    .map(match => normalizeText(decodeXmlText(match[1] || '')))
    .filter(Boolean);
}

export function extractOoxmlTextBlocks(xml: string): string[] {
  const paragraphs = Array.from(xml.matchAll(/<a:p(?:\s[^>]*)?>[\s\S]*?<\/a:p>/g))
    .map(match => collectTextRuns(match[0]).join(' '))
    .map(normalizeText)
    .filter(Boolean);

  const blocks = paragraphs.length > 0 ? paragraphs : collectTextRuns(xml);
  return blocks.filter((block, index) => block !== blocks[index - 1]);
}

async function extractEntries(zip: PptxZipLike, pattern: RegExp, label: string): Promise<string[]> {
  const entries = Object.values(zip.files)
    .filter(file => !file.dir && pattern.test(file.name))
    .sort((a, b) => slideNumber(a.name) - slideNumber(b.name));

  const sections: string[] = [];
  for (const entry of entries) {
    const xml = await entry.async('string');
    const blocks = extractOoxmlTextBlocks(xml);
    if (blocks.length === 0) continue;
    sections.push(`[${label} ${slideNumber(entry.name)}]\n${blocks.join('\n')}`);
  }
  return sections;
}

export async function extractPptxText(filePath: string): Promise<string> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath)) as PptxZipLike;
  const slides = await extractEntries(zip, /^ppt\/slides\/slide\d+\.xml$/i, 'Slide');
  const notes = await extractEntries(zip, /^ppt\/notesSlides\/notesSlide\d+\.xml$/i, 'Speaker Notes');
  return [...slides, ...notes].join('\n\n').trim();
}
