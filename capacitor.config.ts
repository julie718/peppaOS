import { CapacitorConfig } from '@capacitor/cli';

// Before using: run `npx cap add android` or `npx cap add ios` to create platform directories
const config: CapacitorConfig = {
  appId: 'com.lumiai.app',
  appName: 'LumiAI',
  webDir: 'dist',
  server: {
    androidScheme: 'https'
  }
};

export default config;
