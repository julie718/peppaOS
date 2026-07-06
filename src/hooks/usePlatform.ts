import { useState, useEffect, useCallback } from 'react';

export type Platform = 'web' | 'electron' | 'tauri' | 'ios' | 'android';

export interface SensorData {
  latitude?: number;
  longitude?: number;
  speed?: number;
  acceleration?: { x: number; y: number; z: number };
}

export function usePlatform() {
  const [platform, setPlatform] = useState<Platform>(() => {
    if (typeof window !== 'undefined') {
      if ((window as any).peppaElectron || navigator.userAgent.toLowerCase().includes('electron')) {
        return 'electron';
      }
      if ((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI_IPC__ || (window as any).__TAURI__) {
        return 'tauri';
      }
    }
    return 'web';
  });
  const [isSyncing, setIsSyncing] = useState(false);
  const [sensors, setSensors] = useState<SensorData>({});

  useEffect(() => {
    // Check for Electron
    if (window && (window as any).peppaElectron) {
      setPlatform('electron');
      return;
    }

    // Check for Tauri
    if (window && ((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI_IPC__ || (window as any).__TAURI__)) {
      setPlatform('tauri');
      return;
    }

    // Check for Capacitor/Cordova (Mobile)
    const win = window as any;
    const isMobile = !!(win.Capacitor && win.Capacitor.platform !== 'web');
    
    if (isMobile) {
      setPlatform(win.Capacitor.platform as Platform);
    } else {
      setPlatform('web');
    }
  }, []);

  const startSensorSync = useCallback(() => {
    setIsSyncing(true);
    const cleanupFns: (() => void)[] = [];

    // Real GPS via Geolocation API
    if (navigator.geolocation) {
      const watchId = navigator.geolocation.watchPosition(
        (pos) => {
          setSensors(prev => ({
            ...prev,
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            speed: pos.coords.speed || 0,
          }));
        },
        (err) => console.error('[Sensors] GPS error:', err.message),
        { enableHighAccuracy: true },
      );
      cleanupFns.push(() => navigator.geolocation.clearWatch(watchId));
    }

    // Real accelerometer via DeviceMotionEvent
    if ('DeviceMotionEvent' in window) {
      const handleMotion = (e: DeviceMotionEvent) => {
        const acc = e.accelerationIncludingGravity;
        if (acc) {
          setSensors(prev => ({
            ...prev,
            acceleration: {
              x: acc.x ?? 0,
              y: acc.y ?? 0,
              z: acc.z ?? 9.8,
            },
          }));
        }
      };
      window.addEventListener('devicemotion', handleMotion);
      cleanupFns.push(() => window.removeEventListener('devicemotion', handleMotion));
    }

    return () => {
      cleanupFns.forEach(fn => fn());
      setIsSyncing(false);
    };
  }, []);

  return {
    platform,
    isElectron: platform === 'electron',
    isTauri: platform === 'tauri',
    isDesktop: platform === 'electron' || platform === 'tauri',
    isMobile: platform === 'ios' || platform === 'android',
    isWeb: platform === 'web',
    electronAPI: (window as any).peppaElectron || null,
    startSensorSync,
    sensors,
    isSyncing
  };
}
