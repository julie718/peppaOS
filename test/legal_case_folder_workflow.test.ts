import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runLegalCaseFolderWorkflow } from '../server/skills/bundled/legal-casework/folder_workflow';

describe('legal case folder workflow', () => {
  it('extracts case signals and writes lawyer-facing work papers', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peppa_legal_case_'));
    try {
      fs.writeFileSync(path.join(dir, '案情.txt'), `
案由：买卖合同纠纷
原告：上海甲公司
被告：北京乙公司
案号：（2025）沪0101民初123号
上海市黄浦区人民法院
2025年3月12日签订合同，约定供货并支付货款人民币 35万元。
证据包括合同、订单、微信聊天记录、银行流水、发票、送货签收单。
`, 'utf-8');
      fs.writeFileSync(
        path.join(dir, '沟通.rtf'),
        String.raw`{\rtf1 微信聊天记录\par 2025年4月2日 被告确认欠款人民币 35万元\par}`,
        'utf-8',
      );
      fs.writeFileSync(path.join(dir, '现场照片.png'), 'not extractable', 'utf-8');

      const result = await runLegalCaseFolderWorkflow({
        folderPath: dir,
        caseName: '甲乙买卖合同案',
        matterType: '买卖合同纠纷',
        clientRole: '原告',
        objective: '整理委托书和代理词',
        writeFiles: true,
        maxFiles: 10,
      });

      expect(result.filesRead.map(file => file.name)).toEqual(expect.arrayContaining(['案情.txt', '沟通.rtf']));
      expect(result.filesSkipped.some(file => file.reason.includes('unsupported extension'))).toBe(true);
      expect(result.signals.caseNumbers).toContain('（2025）沪0101民初123号');
      expect(result.signals.courts).toContain('上海市黄浦区人民法院');
      expect(result.signals.parties).toEqual(expect.arrayContaining(['上海甲公司', '北京乙公司']));
      expect(result.signals.amounts).toContain('人民币 35万元');
      expect(result.signals.evidenceTypes).toEqual(expect.arrayContaining(['合同/协议', '沟通记录', '付款凭证', '履行/交付材料']));
      expect(result.searchPlan.faxinQueries.some(query => query.includes('代理词'))).toBe(true);
      expect(result.authorizationSteps.join('\n')).toContain('china-judgments-online');

      const outputDir = result.outputDir || '';
      expect(fs.existsSync(path.join(outputDir, '12_代理词框架.md'))).toBe(true);
      const sourceTable = fs.readFileSync(path.join(outputDir, '02_来源登记表.md'), 'utf-8');
      expect(sourceTable).toContain('法信');
      expect(sourceTable).toContain('裁判文书网');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns previews without writing files when writeFiles is false', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peppa_legal_case_preview_'));
    try {
      fs.writeFileSync(path.join(dir, '材料.txt'), '原告：甲公司\n被告：乙公司\n合同纠纷\n付款人民币 10万元', 'utf-8');
      const result = await runLegalCaseFolderWorkflow({ folderPath: dir, writeFiles: false, maxFiles: 5 });

      expect(result.outputDir).toBeUndefined();
      expect(result.draftFiles.length).toBeGreaterThan(0);
      expect(result.draftFiles.every(file => !file.path && file.preview.length > 0)).toBe(true);
      expect(fs.existsSync(path.join(dir, 'Peppa法律工作底稿'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
