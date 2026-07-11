import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.mayos.app',
  appName: 'MayOS',
  webDir: 'dist/mobile',
  server: {
    url: 'https://qweasd.top:4043/index.mobile.html',
    cleartext: true
  },
  ios: {
    contentInset: 'always',
    scrollEnabled: false,
    allowsLinkPreview: false
  }
};

export default config;
