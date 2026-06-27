# local_whisper.py — faster-whisper STT for LumiOS
# Usage: python local_whisper.py <audio_file_path> [language]
# Output: transcribed text to stdout
#
# First run auto-installs faster-whisper if not present.
# Model (~500MB) caches to $WHISPER_MODEL_DIR or ../data/whisper_models/

import os, sys, subprocess, json, site

MODEL = "small"  # tiny(150MB)/base(280MB)/small(500MB)/medium(1.5GB)/large(3GB)

def ensure_deps():
    try:
        from faster_whisper import WhisperModel
        return WhisperModel
    except ImportError:
        print("[local_whisper] Installing faster-whisper (one-time)...", file=sys.stderr)
        subprocess.check_call([sys.executable, "-m", "pip", "install", "faster-whisper", "-q"])
        print("[local_whisper] Done.", file=sys.stderr)
        from faster_whisper import WhisperModel
        return WhisperModel

def main():
    if len(sys.argv) < 2:
        print("Usage: python local_whisper.py <wav_file>", file=sys.stderr)
        sys.exit(1)

    audio_path = sys.argv[1]
    language = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else "zh"
    if not os.path.exists(audio_path):
        print(f"File not found: {audio_path}", file=sys.stderr)
        sys.exit(1)

    WhisperModel = ensure_deps()

    # Model cache directory — prefer project data dir
    model_dir = os.environ.get("WHISPER_MODEL_DIR", "")
    if not model_dir:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        project_data = os.path.join(script_dir, "..", "..", "data", "whisper_models")
        model_dir = os.path.abspath(project_data)
    os.makedirs(model_dir, exist_ok=True)

    print(f"[local_whisper] Loading model '{MODEL}' from {model_dir}...", file=sys.stderr)
    model = WhisperModel(MODEL, device="cpu", compute_type="int8", download_root=model_dir)

    segments, info = model.transcribe(audio_path, language=language, beam_size=5)
    detected = info.language
    print(f"[local_whisper] Detected language: {detected} (prob {info.language_probability:.3f})", file=sys.stderr)

    text = "".join(seg.text for seg in segments).strip()
    print(text)

if __name__ == "__main__":
    main()
