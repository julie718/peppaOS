import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.mayos.app',
  appName: 'MayOS',
  webDir: 'dist/mobile',
  server: {
    url: 'https://peppa.qweasd.top/index.mobile.html',
    cleartext: true
  },
  ios: {
    contentInset: 'always',
    scrollEnabled: false,
    allowsLinkPreview: false
  }
};

export default config;
