import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { makeApp } from './helpers';
import { ToolRegistry } from '../server/tools/registry';
import { getWebLoginSitePreset, listWebLoginSitePresets } from '../server/web_login/legal_presets';

let cleanup = () => {};
let registerLegalTools: (registry: ToolRegistry) => void;
let registerWebLoginTools: (registry: ToolRegistry) => void;

beforeAll(async () => {
  const app = await makeApp();
  cleanup = app.cleanup;
  ({ registerLegalTools } = await import('../server/tools/definitions/legal_tools'));
  ({ registerWebLoginTools } = await import('../server/tools/definitions/web_login_tools'));
});

afterAll(() => {
  cleanup();
});

function createLegalRegistry() {
  const registry = new ToolRegistry();
  registerLegalTools(registry);
  return registry;
}

describe('semi-automated legal workflows', () => {
  it('drafts plaintiff litigation packets with manual filing gates', async () => {
    const registry = createLegalRegistry();

    const output = await registry.execute('legal_generate_litigation_packet', {
      caseName: 'Sales Contract Case',
      role: 'plaintiff',
      caseType: '买卖合同纠纷',
      court: '上海市黄浦区人民法院',
      parties: 'Plaintiff: Alpha Trading Co.; Defendant: Beta Retail Co.',
      claims: '请求支付货款及违约金',
      facts: '2026年1月签订买卖合同，Alpha 已供货，Beta 尚欠货款 350000 元。',
      evidence: '合同、订单、发货单、签收单、发票、银行流水。',
    });

    expect(output).toContain('Sales Contract Case');
    expect(output).not.toMatch(/底层三段论|三段论|大前提|小前提|涵摄/);
    expect(output).toMatch(/起诉状|要素式诉状|诉讼文书包/);
    expect(output).toMatch(/证据目录|证明目的/);
    expect(output).toMatch(/律师|人工|确认/);
    expect(output).toContain('web_login_run');
  });

  it('drafts defendant response packets without auto-submitting anything', async () => {
    const registry = createLegalRegistry();

    const output = await registry.execute('legal_generate_litigation_packet', {
      caseName: 'Defense Contract Case',
      role: 'defendant',
      caseType: '买卖合同纠纷',
      facts: '原告主张被告拖欠货款，但货物存在严重质量问题且双方曾协商退货。',
      evidence: '验收异议函、聊天记录、退货沟通记录、原告起诉状。',
      opponentMaterials: '原告起诉状、证据目录、合同复印件。',
    });

    expect(output).toContain('Defense Contract Case');
    expect(output).not.toMatch(/底层三段论|三段论|大前提|小前提|涵摄/);
    expect(output).toMatch(/答辩状|质证意见/);
    expect(output).toMatch(/程序抗辩|时效|主体资格/);
    expect(output).toMatch(/提交|签字|盖章|发送/);
    expect(output).toMatch(/律师|人工|确认/);
  });

  it('builds external research plans around authorized browser sessions', async () => {
    const registry = createLegalRegistry();

    const output = await registry.execute('legal_external_research_plan', {
      caseType: '买卖合同纠纷',
      facts: '合同履行后拖欠货款，争议集中在质量异议、付款条件和违约金调整。',
      issues: ['货款支付条件', '质量异议抗辩', '违约金调整'],
      companyNames: ['Beta Retail Co.', 'Alpha Trading Co.'],
    });

    expect(output).toContain('web_login_profile_save_from_preset');
    expect(output).toContain('web_login_run');
    expect(output).not.toMatch(/底层三段论|三段论检索框架|大前提|小前提|涵摄/);
    expect(output).toContain('"profileId":"court-online-service"');
    expect(output).toContain('people-court-case-library');
    expect(output).toContain('china-judgments-online');
    expect(output).toContain('fachan');
    expect(output).toContain('alpha-lawyer');
    expect(output).toContain('qichacha');
    expect(output).toContain('national-enterprise-credit');
    expect(output).toContain('court-online-service');
    expect(output).toMatch(/来源登记表|来源.*登记/);
  });

  it('keeps triad reasoning as underlying logic rather than a standalone UI tab', () => {
    const registry = createLegalRegistry();
    const legalHubSource = fs.readFileSync(path.join(process.cwd(), 'src/components/org/LegalHub.tsx'), 'utf-8');
    const toolRouterSource = fs.readFileSync(path.join(process.cwd(), 'server/cognition/tool_router.ts'), 'utf-8');

    expect(legalHubSource).not.toContain("id: 'triad'");
    expect(legalHubSource).not.toContain('LegalTriadView');
    expect(legalHubSource).toContain('legal_generate_litigation_packet');
    expect(legalHubSource).toContain('legal_external_research_plan');
    expect(registry.get('legal_triad_analysis')).toBeUndefined();
    expect(toolRouterSource).not.toContain('legal_triad_analysis');
  });
});

describe('legal web login presets', () => {
  const requiredPresetIds = [
    'faxin',
    'china-judgments-online',
    'people-court-case-library',
    'court-online-service',
    'qichacha',
    'national-enterprise-credit',
    'fachan',
    'alpha-lawyer',
  ];

  it('exposes all legal research and filing presets', () => {
    const presets = listWebLoginSitePresets('legal');
    const ids = presets.map(preset => preset.id);

    expect(ids).toEqual(expect.arrayContaining(requiredPresetIds));
    for (const id of requiredPresetIds) {
      const preset = getWebLoginSitePreset(id);
      expect(preset).toBeTruthy();
      expect(preset?.loginUrl).toMatch(/^https:\/\//);
      expect(preset?.matchHosts.length).toBeGreaterThan(0);
      expect(preset?.notes).toMatch(/Lumi/);
      expect(preset?.notes).toMatch(/授权|登录|人工|验证码|限制/);
    }
  });

  it('lists legal presets through the web login tool without touching credentials', async () => {
    const registry = new ToolRegistry();
    registerWebLoginTools(registry);

    const output = await registry.execute(
      'web_login_site_presets',
      { category: 'legal' },
      { requestConfirmation: async () => true },
    );
    const data = JSON.parse(output);
    const ids = data.presets.map((preset: { id: string }) => preset.id);

    expect(ids).toEqual(expect.arrayContaining(requiredPresetIds));
    expect(data.note).toContain('web_login_profile_save_from_preset');
  });
});
