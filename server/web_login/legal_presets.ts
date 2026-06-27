export type WebLoginSitePreset = {
  id: string;
  label: string;
  category: 'legal';
  loginUrl: string;
  matchHosts: string[];
  notes: string;
  sourceUrl: string;
};

export const LEGAL_WEB_LOGIN_PRESETS: WebLoginSitePreset[] = [
  {
    id: 'faxin',
    label: '法信',
    category: 'legal',
    loginUrl: 'https://www.faxin.cn/login.aspx',
    matchHosts: ['faxin.cn', 'www.faxin.cn', 'sfb-vip.faxin.cn', 'm.faxin.cn'],
    sourceUrl: 'https://www.faxin.cn/',
    notes: [
      '法信内容通常受账号授权和服务协议限制。',
      'Lumi 只保存用户授权的本机登录会话，不批量抓取、不共享账号、不绕过验证码或机构访问限制。',
      '如遇单位公网密码、SSO、扫码或验证码，请使用可见浏览器手动完成一次，之后复用会话。',
    ].join(' '),
  },
  {
    id: 'china-judgments-online',
    label: '中国裁判文书网',
    category: 'legal',
    loginUrl: 'https://wenshu.court.gov.cn/website/wenshu/181010CARHS5BS3C/index.html?open=login',
    matchHosts: ['wenshu.court.gov.cn'],
    sourceUrl: 'https://wenshu.court.gov.cn/',
    notes: [
      '中国裁判文书网是最高人民法院裁判文书公开平台，访问通常需要注册/登录。',
      '登录方式、验证码、支付宝/钉钉等第三方验证需要用户本人在可见浏览器中完成。',
      'Lumi 复用已授权会话做检索阅读，不绕过反爬、验证码、访问频控或下载限制。',
    ].join(' '),
  },
];

export function listWebLoginSitePresets(category?: string): WebLoginSitePreset[] {
  const normalized = String(category || '').trim().toLowerCase();
  if (!normalized) return LEGAL_WEB_LOGIN_PRESETS;
  return LEGAL_WEB_LOGIN_PRESETS.filter(preset => preset.category === normalized);
}

export function getWebLoginSitePreset(id: string): WebLoginSitePreset | undefined {
  const normalized = String(id || '').trim().toLowerCase();
  return LEGAL_WEB_LOGIN_PRESETS.find(preset => preset.id === normalized);
}
