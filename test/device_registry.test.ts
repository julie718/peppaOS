import { describe, it, expect } from 'vitest';

// Import the singleton instance (resets between tests since it's in-memory)
import { deviceRegistry } from '../server/devices';

describe('DeviceRegistry', () => {
  it('registers a new device', () => {
    const device = deviceRegistry.register('user1', 'socket1', {
      name: 'Test Desktop',
      type: 'desktop',
      capabilities: { audio: true, video: false, spatial: false, haptic: false, holographic: false },
    });

    expect(device.id).toBe('dev_user1_socket1');
    expect(device.name).toBe('Test Desktop');
    expect(device.status).toBe('online');
    expect(device.capabilities.audio).toBe(true);
    expect(device.capabilities.video).toBe(false);
  });

  it('re-registering the same device updates status and lastSeen', () => {
    const first = deviceRegistry.register('user_rereg', 'sock_rereg', { name: 'First Name' });
    const second = deviceRegistry.register('user_rereg', 'sock_rereg', { name: 'Second Name' });

    expect(second.id).toBe(first.id);
    // Name is preserved from first registration, not overwritten
    expect(second.name).toBe('First Name');
    expect(second.status).toBe('online');
    // lastSeen is updated (>= original timestamp)
    expect(second.lastSeen >= first.lastSeen).toBe(true);
  });

  it('returns empty sensory context for unknown user', () => {
    const ctx = deviceRegistry.getSensoryContext('nonexistent');
    expect(ctx.hasAudio).toBe(false);
    expect(ctx.hasVideo).toBe(false);
    expect(ctx.hasSpatial).toBe(false);
    expect(ctx.hasHaptic).toBe(false);
    expect(ctx.hasHolographic).toBe(false);
    expect(ctx.deviceCount).toBe(0);
  });

  it('aggregates sensory context across multiple devices', () => {
    deviceRegistry.register('user2', 'sock_a', {
      name: 'Desktop', type: 'desktop',
      capabilities: { audio: true, video: true, spatial: false, haptic: false, holographic: false },
    });
    deviceRegistry.register('user2', 'sock_b', {
      name: 'AR Glasses', type: 'ar_glasses',
      capabilities: { audio: true, video: true, spatial: true, haptic: false, holographic: true },
    });

    const ctx = deviceRegistry.getSensoryContext('user2');
    expect(ctx.hasAudio).toBe(true);
    expect(ctx.hasVideo).toBe(true);
    expect(ctx.hasSpatial).toBe(true);
    expect(ctx.hasHolographic).toBe(true);
    expect(ctx.deviceCount).toBe(2);
    expect(ctx.activeDeviceTypes).toContain('desktop');
    expect(ctx.activeDeviceTypes).toContain('ar_glasses');
  });

  it('disconnecting a device marks it offline', () => {
    deviceRegistry.register('user3', 'sock_c', { name: 'Phone', type: 'mobile' });
    deviceRegistry.disconnect('sock_c');

    const ctx = deviceRegistry.getSensoryContext('user3');
    expect(ctx.deviceCount).toBe(0); // offline devices excluded from context
  });
});
