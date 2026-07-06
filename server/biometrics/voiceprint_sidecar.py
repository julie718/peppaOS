#!/usr/bin/env python3
"""SpeechBrain speaker embedding sidecar for Peppa.

Protocol: JSON lines over stdin/stdout.
Request:
  {"id":"...","action":"embed","pcm16Base64":"...","sampleRate":16000}
Response:
  {"id":"...","ok":true,"provider":"speechbrain-ecapa","model":"...","embedding":[...]}
"""

import base64
import json
import os
import sys
import traceback

MODEL_SOURCE = os.environ.get("LUMI_VOICEPRINT_MODEL", "speechbrain/spkrec-ecapa-voxceleb")
MODEL_DIR = os.environ.get("LUMI_VOICEPRINT_MODEL_DIR")
DEVICE = os.environ.get("LUMI_VOICEPRINT_DEVICE", "cpu")
TARGET_SAMPLE_RATE = 16000

_classifier = None
_torch = None
_torchaudio = None


def _project_model_dir() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.abspath(os.path.join(here, "..", "..", "data", "voiceprint_models"))


def _load_model():
    global _classifier, _torch, _torchaudio
    if _classifier is not None:
        return _classifier

    try:
        import torch
        import torchaudio
        try:
            from speechbrain.inference.speaker import EncoderClassifier
        except Exception:
            from speechbrain.pretrained import EncoderClassifier
    except Exception as exc:
        return {
            "ok": False,
            "code": "missing_dependency",
            "error": str(exc),
            "install": "python -m pip install -r server/biometrics/requirements-voiceprint.txt",
        }

    savedir = MODEL_DIR or _project_model_dir()
    os.makedirs(savedir, exist_ok=True)
    _torch = torch
    _torchaudio = torchaudio
    _classifier = EncoderClassifier.from_hparams(
        source=MODEL_SOURCE,
        savedir=savedir,
        run_opts={"device": DEVICE},
    )
    return _classifier


def _normalize_embedding(values):
    total = sum(float(v) * float(v) for v in values)
    if total <= 1e-12:
        return []
    scale = total ** 0.5
    return [float(v) / scale for v in values]


def _embed(req):
    model_or_error = _load_model()
    if isinstance(model_or_error, dict):
        return model_or_error

    pcm_b64 = req.get("pcm16Base64")
    sample_rate = int(req.get("sampleRate") or TARGET_SAMPLE_RATE)
    if not isinstance(pcm_b64, str) or not pcm_b64:
        return {"ok": False, "code": "bad_request", "error": "pcm16Base64 is required"}

    raw = base64.b64decode(pcm_b64)
    if len(raw) < int(sample_rate * 0.45) * 2:
        return {"ok": False, "code": "too_short", "error": "speech window is too short"}

    torch = _torch
    torchaudio = _torchaudio
    signal = torch.frombuffer(bytearray(raw), dtype=torch.int16).float() / 32768.0
    if sample_rate != TARGET_SAMPLE_RATE:
        signal = torchaudio.functional.resample(signal, sample_rate, TARGET_SAMPLE_RATE)

    # ECAPA works best with a little speech context; reject tiny post-resample clips.
    if int(signal.numel()) < int(TARGET_SAMPLE_RATE * 0.45):
        return {"ok": False, "code": "too_short", "error": "speech window is too short"}

    with torch.no_grad():
        embedding = model_or_error.encode_batch(signal.unsqueeze(0)).squeeze().detach().cpu().tolist()

    embedding = _normalize_embedding(embedding)
    if not embedding:
        return {"ok": False, "code": "empty_embedding", "error": "model returned empty embedding"}

    return {
        "ok": True,
        "provider": "speechbrain-ecapa",
        "model": MODEL_SOURCE,
        "embedding": embedding,
        "embeddingDim": len(embedding),
        "sampleRate": TARGET_SAMPLE_RATE,
        "durationSec": round(float(signal.numel()) / TARGET_SAMPLE_RATE, 3),
    }


def _handle(req):
    action = req.get("action")
    if action == "health":
        loaded = _classifier is not None
        return {
            "ok": True,
            "provider": "speechbrain-ecapa",
            "model": MODEL_SOURCE,
            "loaded": loaded,
        }
    if action == "embed":
        return _embed(req)
    return {"ok": False, "code": "unknown_action", "error": f"Unknown action: {action}"}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            req = json.loads(line)
            request_id = req.get("id")
            resp = _handle(req)
            resp["id"] = request_id
        except Exception as exc:
            resp = {
                "id": request_id,
                "ok": False,
                "code": "sidecar_error",
                "error": str(exc),
                "trace": traceback.format_exc(limit=2),
            }
        print(json.dumps(resp, ensure_ascii=True), flush=True)


if __name__ == "__main__":
    main()
