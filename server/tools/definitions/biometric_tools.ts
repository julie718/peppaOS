import { ToolRegistry } from '../registry';
import { getVoiceprints, getAllVoiceprints, getFaces, getAllFaces, deleteVoiceprint, deleteFace } from '../../biometrics/store';

async function biometricStatus(_args: Record<string, any>, context?: any): Promise<string> {
  const uid = context?.userId || 'anonymous';
  const voiceprints = getVoiceprints(uid);
  const faces = getFaces(uid);

  const lines: string[] = [];
  lines.push(`Biometric status for user ${uid}:`);
  lines.push(`- Registered voiceprints: ${voiceprints.length}`);
  for (const vp of voiceprints) {
    lines.push(`  · ${vp.label} (last matched: ${vp.lastMatchedAt})`);
  }
  lines.push(`- Registered faces: ${faces.length}`);
  for (const f of faces) {
    lines.push(`  · ${f.label} (last matched: ${f.lastMatchedAt})`);
  }

  if (voiceprints.length === 0 && faces.length === 0) {
    lines.push('No biometric data enrolled. Use biometric_enroll to register voiceprints or faces.');
  }

  return lines.join('\n');
}

async function biometricEnroll(args: Record<string, any>, context?: any): Promise<string> {
  // This tool is a convenience. Actual enrollment happens via:
  // - Voiceprint: POST /api/auth/biometric/voiceprint/enroll (records audio + extracts MFCC)
  // - Face: POST /api/auth/biometric/face/enroll (captures + extracts embedding)
  // The tool tells the user how to enroll.
  const uid = context?.userId || 'anonymous';
  const allVps = getAllVoiceprints();
  const allFaces = getAllFaces();
  const registeredUsers = new Set<string>();
  for (const v of allVps) registeredUsers.add(v.uid);
  for (const f of allFaces) registeredUsers.add(f.uid);

  return [
    'To enroll biometrics, use the Settings → Biometrics panel in the desktop app, or call:',
    '- Voiceprint enrollment: speak 3 short phrases ("Hey Peppa, it\'s me") while the enrollment dialog is open',
    '- Face enrollment: look at the camera and hold still for 2 seconds',
    `Currently registered users: ${registeredUsers.size > 0 ? [...registeredUsers].join(', ') : 'none besides you'}`,
    `Your user ID: ${uid}`,
  ].join('\n');
}

async function biometricVerify(_args: Record<string, any>, _context?: any): Promise<string> {
  // Manual verification — the System will prompt user to look at camera and speak.
  return 'Biometric verification initiated. Please look at the camera and say "Hey Peppa, verify me". The system will compare against enrolled voiceprints and faces in real time.';
}

async function biometricForget(args: Record<string, any>, context?: any): Promise<string> {
  const uid = context?.userId || 'anonymous';
  const type = args.type || 'all';

  const results: string[] = [];

  if (type === 'voiceprint' || type === 'all') {
    const vps = getVoiceprints(uid);
    for (const vp of vps) {
      deleteVoiceprint(uid, vp.voiceprintId);
      results.push(`Deleted voiceprint: ${vp.label}`);
    }
    if (vps.length === 0) results.push('No voiceprints to delete.');
  }

  if (type === 'face' || type === 'all') {
    const faces = getFaces(uid);
    for (const f of faces) {
      deleteFace(uid, f.faceId);
      results.push(`Deleted face: ${f.label}`);
    }
    if (faces.length === 0) results.push('No faces to delete.');
  }

  return results.join('\n');
}

export function registerBiometricTools(registry: ToolRegistry): void {
  registry.register({
    name: 'biometric_status',
    description:
      'Check the current biometric enrollment status — which voiceprints and faces are registered for the current user. Use this to see if biometric verification is available.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: biometricStatus,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'biometric_enroll',
    description:
      'Get instructions for enrolling biometric data (voiceprint and/or face). Use this when a user wants to set up voice or face recognition.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: biometricEnroll,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'biometric_verify',
    description:
      'Manually trigger a biometric verification — asks the user to look at the camera and speak so the system can verify their identity against enrolled voiceprints and faces.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: biometricVerify,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'biometric_forget',
    description:
      'Delete stored biometric data. Use type="voiceprint" to forget voice data, type="face" to forget face data, or type="all" (default) to clear everything.',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'What to delete: "voiceprint", "face", or "all" (default).',
        },
      },
      required: [],
    },
    handler: biometricForget,
    permission: 'user',
    securityLevel: 'confirm',
  });
}
