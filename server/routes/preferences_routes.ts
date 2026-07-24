import { Router } from "express";
import { readDB, writeDB } from "../../db_layer";
import { reverseGeocode } from "../lib/geocode";
import { requireAuth } from "../middleware/auth";
import { broadcastPreferenceChange } from "../memory";
import { normalizeOperationMode, parseStoredOperationMode } from "../cognition/operation_modes";

export function mountPreferencesRoutes(router: Router, _jwtSecret: string) {
  router.get("/preferences/pet", requireAuth, (req, res) => {
    try {
      const uid = req.user!.uid;
      const db = readDB();
      const setting = (db.settings || []).find((s: any) => s.key === `pet_prefs_${uid}`);
      if (setting) {
        res.json(JSON.parse(setting.value));
      } else {
        res.json({ pet: null, accessories: [] });
      }
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.put("/preferences/pet", requireAuth, (req, res) => {
    try {
      const uid = req.user!.uid;
      const { pet, accessories } = req.body || {};
      const db = readDB();
      if (!db.settings) db.settings = [];
      const key = `pet_prefs_${uid}`;
      const value = JSON.stringify({ pet: pet || null, accessories: accessories || [] });
      const existing = db.settings.findIndex((s: any) => s.key === key);
      if (existing >= 0) {
        db.settings[existing].value = value;
      } else {
        db.settings.push({ key, value });
      }
      writeDB(db);
      broadcastPreferenceChange(uid, 'pet', { pet: pet || null, accessories: accessories || [] });
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/preferences/operation_mode", requireAuth, (req, res) => {
    try {
      const uid = req.user!.uid;
      const db = readDB();
      const setting = (db.settings || []).find((s: any) => s.key === `op_mode_${uid}`);
      if (setting) {
        res.json({ mode: parseStoredOperationMode(setting.value) });
      } else {
        res.json({ mode: 'assistant' });
      }
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.put("/preferences/operation_mode", requireAuth, (req, res) => {
    try {
      const uid = req.user!.uid;
      const { mode } = req.body || {};
      if (!mode) return res.status(400).json({ error: 'mode is required' });
      const normalizedMode = normalizeOperationMode(mode);
      const db = readDB();
      if (!db.settings) db.settings = [];
      const key = `op_mode_${uid}`;
      const value = JSON.stringify({ mode: normalizedMode });
      const existing = db.settings.findIndex((s: any) => s.key === key);
      if (existing >= 0) {
        db.settings[existing].value = value;
      } else {
        db.settings.push({ key, value });
      }
      writeDB(db);
      broadcastPreferenceChange(uid, 'operation_mode', { mode: normalizedMode });
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // GPS location — stored per user, read by chat/voice system prompt
  router.put("/preferences/location", requireAuth, async (req, res) => {
    try {
      const uid = req.user!.uid;
      const { lat, lng, address: clientAddress } = req.body || {};
      if (lat == null || lng == null) return res.status(400).json({ error: 'lat and lng are required' });
      // 优先使用客户端 CLGeocoder 反查结果，服务端反查仅作兜底
      const finalAddress = clientAddress || await reverseGeocode(lat, lng).catch(() => '') || `纬度${lat.toFixed(4)}, 经度${lng.toFixed(4)}`;
      console.log('[Location] 客户端 address:', clientAddress || '(空)', '最终 address:', finalAddress);
      const db = readDB();
      if (!db.settings) db.settings = [];
      const key = `location_${uid}`;
      const value = JSON.stringify({ lat, lng, address: finalAddress, updatedAt: new Date().toISOString() });
      const existing = db.settings.findIndex((s: any) => s.key === key);
      if (existing >= 0) db.settings[existing].value = value;
      else db.settings.push({ key, value });
      writeDB(db);
      res.json({ ok: true, address: finalAddress });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/preferences/location", requireAuth, (req, res) => {
    try {
      const uid = req.user!.uid;
      const db = readDB();
      const setting = (db.settings || []).find((s: any) => s.key === `location_${uid}`);
      if (setting) res.json(JSON.parse(setting.value));
      else res.json({ lat: null, lng: null });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}
