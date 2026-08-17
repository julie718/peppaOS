import { CapacitorConfig } from '@capacitor/cli';

// 默认 API 基地址（兜底）。App 启动时 iOS 原生侧会先请求
// <DEFAULT_API_BASE>/config.json 获取最新 apiBase 并覆盖此值
// （见 ios/App/App/RemoteConfig.swift），以后服务器域名变更只需修改
// 服务器上的 config.json，无需重新编译 App。
const DEFAULT_API_BASE = 'https://peppaos.qweasd.top';

const config: CapacitorConfig = {
  appId: 'com.mayos.app',
  appName: 'MayOS',
  webDir: 'dist/mobile',
  server: {
    url: `${DEFAULT_API_BASE}/index.mobile.html`,
    cleartext: true,
  },
  ios: {
    contentInset: 'always',
    scrollEnabled: false,
    allowsLinkPreview: false,
  },
};

export default config;
