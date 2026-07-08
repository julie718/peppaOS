import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.mayos.app',
  appName: 'MayOS',
  webDir: 'dist/mobile',
  server: {
    url: 'http://qweasd.top:3000',
    cleartext: true
  },
  ios: {
    contentInset: 'always'
  }
};

export default config;
