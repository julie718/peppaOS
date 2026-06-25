export type SensorKind = 'microphone' | 'camera';
export type SensorPermissionState = PermissionState | 'unknown' | 'unavailable';
export type DesktopAutomationState = 'available' | 'unavailable' | 'unknown';

export interface SensorPermissionSnapshot {
  microphone: SensorPermissionState;
  camera: SensorPermissionState;
  notifications: SensorPermissionState;
  desktopAutomation?: DesktopAutomationState;
  wakeWordEnabled?: boolean;
  sensorPrimerSeen?: boolean;
  biometricsPrimerSeen?: boolean;
  updatedAt: number;
}

interface SnapshotOptions {
  desktopAutomation?: DesktopAutomationState;
  wakeWordEnabled?: boolean;
  sensorPrimerSeen?: boolean;
  biometricsPrimerSeen?: boolean;
}

export const SENSOR_PERMISSIONS_CHANGED = 'lumi:sensor-permissions-changed';

function hasNavigator() {
  return typeof navigator !== 'undefined';
}

function hasWindow() {
  return typeof window !== 'undefined';
}

function getFallbackPermissionState(name: SensorKind | 'notifications'): SensorPermissionState {
  if (!hasNavigator()) return 'unavailable';
  if ((name === 'microphone' || name === 'camera') && !navigator.mediaDevices?.getUserMedia) return 'unavailable';
  return 'unknown';
}

export async function queryPermission(name: SensorKind | 'notifications'): Promise<SensorPermissionState> {
  if (!hasNavigator()) return 'unavailable';
  if ((name === 'microphone' || name === 'camera') && !navigator.mediaDevices?.getUserMedia) {
    return 'unavailable';
  }

  try {
    if (!navigator.permissions?.query) return getFallbackPermissionState(name);
    const status = await navigator.permissions.query({ name } as PermissionDescriptor);
    return status.state || 'unknown';
  } catch {
    return getFallbackPermissionState(name);
  }
}

export async function getSensorPermissionSnapshot(options: SnapshotOptions = {}): Promise<SensorPermissionSnapshot> {
  const [microphone, camera, notifications] = await Promise.all([
    queryPermission('microphone'),
    queryPermission('camera'),
    queryPermission('notifications'),
  ]);

  return {
    microphone,
    camera,
    notifications,
    desktopAutomation: options.desktopAutomation,
    wakeWordEnabled: options.wakeWordEnabled,
    sensorPrimerSeen: options.sensorPrimerSeen,
    biometricsPrimerSeen: options.biometricsPrimerSeen,
    updatedAt: Date.now(),
  };
}

export function broadcastSensorPermissionChange(detail?: Partial<SensorPermissionSnapshot>) {
  if (!hasWindow()) return;
  window.dispatchEvent(new CustomEvent(SENSOR_PERMISSIONS_CHANGED, {
    detail: {
      ...detail,
      updatedAt: Date.now(),
    },
  }));
}

export async function requestSensorPermission(kind: SensorKind): Promise<{
  ok: boolean;
  state: SensorPermissionState;
  error?: string;
}> {
  if (!hasNavigator() || !navigator.mediaDevices?.getUserMedia) {
    const state: SensorPermissionState = 'unavailable';
    broadcastSensorPermissionChange({ [kind]: state } as Partial<SensorPermissionSnapshot>);
    return { ok: false, state, error: 'Media devices are unavailable in this runtime.' };
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: kind === 'microphone',
      video: kind === 'camera',
    });
    stream.getTracks().forEach(track => track.stop());
    const state = await queryPermission(kind);
    const nextState = state === 'unknown' ? 'granted' : state;
    broadcastSensorPermissionChange({ [kind]: nextState } as Partial<SensorPermissionSnapshot>);
    return { ok: nextState === 'granted', state: nextState };
  } catch (err: any) {
    const state = await queryPermission(kind);
    const nextState = state === 'unknown' ? 'denied' : state;
    broadcastSensorPermissionChange({ [kind]: nextState } as Partial<SensorPermissionSnapshot>);
    return {
      ok: false,
      state: nextState,
      error: err?.message || `Failed to request ${kind} permission.`,
    };
  }
}

export async function requestMicrophoneStream(audio: MediaStreamConstraints['audio'] = true): Promise<MediaStream> {
  if (!hasNavigator() || !navigator.mediaDevices?.getUserMedia) {
    broadcastSensorPermissionChange({ microphone: 'unavailable' });
    throw new Error('Microphone is unavailable in this runtime.');
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    broadcastSensorPermissionChange({ microphone: 'granted' });
    return stream;
  } catch (err) {
    const state = await queryPermission('microphone');
    broadcastSensorPermissionChange({ microphone: state === 'unknown' ? 'denied' : state });
    throw err;
  }
}

export async function requestCameraStream(video: MediaStreamConstraints['video'] = true): Promise<MediaStream> {
  if (!hasNavigator() || !navigator.mediaDevices?.getUserMedia) {
    broadcastSensorPermissionChange({ camera: 'unavailable' });
    throw new Error('Camera is unavailable in this runtime.');
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    broadcastSensorPermissionChange({ camera: 'granted' });
    return stream;
  } catch (err) {
    const state = await queryPermission('camera');
    broadcastSensorPermissionChange({ camera: state === 'unknown' ? 'denied' : state });
    throw err;
  }
}
