import { Router } from "express";
import { deviceRegistry } from "../devices";
import { optionalAuth } from "../middleware/auth";

export function mountDeviceRoutes(router: Router, _jwtSecret: string) {
  router.post("/devices/pair", (req, res) => {
    const { deviceId } = req.body || {};
    if (!deviceId) return res.status(400).json({ error: "deviceId required" });
    res.json({ success: true, paired: deviceId, timestamp: new Date().toISOString() });
  });

  router.get("/devices", optionalAuth, (req, res) => {
    const userId = req.user?.uid || '';
    const userDevices = userId ? deviceRegistry.getUserDevices(userId) : [];
    const mcpDevices = deviceRegistry.getMcpDevices();
    const devices = [...userDevices, ...mcpDevices];
    const sensory = userId ? deviceRegistry.getSensoryContext(userId) : { hasAudio: false, hasVideo: false, hasSpatial: false, hasHaptic: false, hasHolographic: false, activeDeviceTypes: [], deviceCount: mcpDevices.length };
    res.json({ devices, sensoryContext: sensory });
  });
}
