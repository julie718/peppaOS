import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';
import { extractOoxmlTextBlocks, extractPptxText } from '../server/knowledge/pptx';

function slideXml(texts: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld>
    <p:spTree>
      ${texts.map(text => `<p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`).join('')}
    </p:spTree>
  </p:cSld>
</p:sld>`;
}

describe('PPTX extraction', () => {
  it('extracts text runs from OOXML paragraphs', () => {
    const xml = '<a:p><a:r><a:t>第一行</a:t></a:r><a:r><a:t>&amp; 重点</a:t></a:r></a:p>';
    expect(extractOoxmlTextBlocks(xml)).toEqual(['第一行 & 重点']);
  });

  it('extracts slide and speaker-note text from a pptx archive', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
    zip.file('ppt/slides/slide1.xml', slideXml(['Peppa 项目计划', '第一阶段：资料吸收']));
    zip.file('ppt/slides/slide2.xml', slideXml(['第二阶段：主动学习']));
    zip.file('ppt/notesSlides/notesSlide1.xml', slideXml(['备注：优先处理知识库闭环']));

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peppa_pptx_test_'));
    const filePath = path.join(dir, 'deck.pptx');
    try {
      fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
      const text = await extractPptxText(filePath);
      expect(text).toContain('[Slide 1]');
      expect(text).toContain('Peppa 项目计划');
      expect(text).toContain('第二阶段：主动学习');
      expect(text).toContain('[Speaker Notes 1]');
      expect(text).toContain('优先处理知识库闭环');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
