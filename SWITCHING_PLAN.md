# 🧠 Peppa Local ↔ Cloud Switching Plan
## *The Art of Knowing Where to Think*

---

## 1. 🌿 The Biological Metaphor

Your nervous system doesn't think with just one brain. It has:

| System | Location | Speed | Purpose |
|--------|----------|-------|---------|
| **Spinal reflex** | Local spine | ~2ms | Don't touch fire — survival |
| **Cerebellum** | Local hindbrain | ~10ms | Walk, balance, habit |
| **Cortex** | Local forebrain | ~50ms | Reason, plan, create |
| **Global mind** | Cloud / tribe | ~500ms | Collective memory, culture, wisdom |

**Peppa's architecture mirrors this.** Local models are your spinal cord and cerebellum — fast, private, always-on. Cloud models are your connection to the global mind — vast, wise, evolving.

The switching system is *metacognition* — the brain deciding *which brain to use*.

---

## 2. 🎯 Six Switching Strategies

### 1. **`cloud_first`** — *"Connect to the global mind, use local only in isolation"*
- **Behavior**: Always try cloud. If unreachable → fall back to local.
- **Use case**: Desktop with reliable internet. Maximum capability.
- **Failure mode**: Latency spikes → local takes over gracefully.

### 2. **`local_first`** — *"Think locally, escalate globally"*
- **Behavior**: Always try local. For tasks exceeding complexity threshold → escalate to cloud.
- **Use case**: Laptop on train, intermittent internet. Privacy-critical work.
- **Failure mode**: Local model too weak → cloud handles complex tasks.

### 3. **`auto`** — *"The intelligent default"* 🏆
- **Behavior**: Analyze each request's complexity score:
  ```
  complexity = f(prompt_length, reasoning_depth, domain_novelty, user_intent)
  ```
  - complexity < threshold → local (fast, cheap, private)
  - complexity >= threshold → cloud (powerful, knowledgeable)
- **Use case**: General-purpose. Best of both worlds.
- **Complexity signals**:
  - Prompt length > 500 tokens → +0.2
  - Requires multi-step reasoning → +0.3
  - Domain-specific knowledge needed → +0.2
  - Creative/divergent task → +0.2
  - User explicitly requests "think harder" → +0.3

### 4. **`manual`** — *"The user is the CEO"*
- **Behavior**: Every request must include `_model: "local"` or `_model: "cloud"` in metadata.
- **Use case**: Testing, debugging, power users who know exactly what they want.
- **UX**: Add a subtle toggle in the UI: 🐢 Local | ☁️ Cloud

### 5. **`hybrid`** — *"Two brains are better than one"*
- **Behavior**: Send request to BOTH local and cloud simultaneously.
  - First response wins (for latency-sensitive tasks)
  - Or: both generate, then evaluate which response is better
  - Or: local drafts, cloud reviews/refines
- **Use case**: Mission-critical responses where quality matters above all.
- **Cost**: 2× compute. Use sparingly.

### 6. **`cost_optimized`** — *"The economic brain"*
- **Behavior**: Calculate cost-per-token for each path:
  ```
  local_cost = electricity + hardware depreciation ≈ $0.00/token
  cloud_cost = API pricing ≈ $0.002-0.03/token
  ```
  - If local quality is "good enough" (estimated via complexity score) → use local
  - If quality gap justifies cloud cost → use cloud
- **Use case**: Budget-conscious deployments, SaaS products.

---

## 3. 🔄 The Switching Engine (Pseudocode)

```python
class ModelRouter:
    def __init__(self, config):
        self.local = LocalModel(config.local)
        self.cloud = CloudModel(config.cloud)
        self.strategy = config.routing.strategy
        self.latency_tracker = LatencyWindow(config.routing.latency_monitoring.window_size)

    def route(self, request):
        strategy = self._resolve_strategy(request)

        if strategy == "manual":
            return self._route_manual(request)

        if strategy == "cloud_first":
            return self._try_cloud_fallback_local(request)

        if strategy == "local_first":
            return self._try_local_escalate_cloud(request)

        if strategy == "auto":
            return self._route_auto(request)

        if strategy == "hybrid":
            return self._route_hybrid(request)

        if strategy == "cost_optimized":
            return self._route_cost(request)

    def _resolve_strategy(self, request):
        """Strategy can be overridden per-request via metadata"""
        if request.metadata.get("_model") in ("local", "cloud"):
            return "manual"
        if self.latency_tracker.cloud_latency > self.config.auto_switch_threshold_ms:
            return "local_first"  # adaptive degradation
        return self.strategy

    def _route_auto(self, request):
        score = self._compute_complexity(request)
        if score >= self.config.routing.complexity_threshold:
            return self._try_cloud_fallback_local(request)
        return self.local.infer(request)

    def _compute_complexity(self, request):
        """0.0 (trivial) → 1.0 (extremely complex)"""
        c = 0.0
        c += min(len(request.prompt) / 2000, 0.3)  # length signal
        c += 0.2 if request.requires_reasoning else 0.0
        c += 0.2 if request.requires_external_knowledge else 0.0
        c += 0.1 if request.intent == "creative" else 0.0
        c += 0.2 if request.metadata.get("priority") == "high" else 0.0
        return min(c, 1.0)

    def _try_cloud_fallback_local(self, request):
        try:
            start = time.now()
            response = self.cloud.infer(request, timeout=self.config.fallback.timeout_ms)
            self.latency_tracker.record_cloud(time.now() - start)
            return response
        except (TimeoutError, ConnectionError, APIError):
            logger.warn("Cloud unavailable, falling back to local")
            return self.local.infer(request)
```

---

## 4. 🧪 Latency-Adaptive Switching

The system doesn't just switch *statically* — it adapts in real-time:

```
                    ╔══════════════════════╗
                    ║  Latency Monitor     ║
                    ║  (sliding window=10) ║
                    ╚══════════════════════╝
                              │
                    ┌─────────┴─────────┐
                    ▼                   ▼
            Cloud avg < 5s        Cloud avg ≥ 5s
                    │                   │
              Stay on cloud      Auto-switch to local
                    │                   │
                    │            ╔══════════════╗
                    │            ║ Try cloud    ║
                    │            ║ every 60s    ║
                    │            ║ to recover   ║
                    │            ╚══════════════╝
```

This prevents the "thrashing" problem — switching back and forth too rapidly.

---

## 5. 🔐 Secret Management (Security First)

**Rule**: API keys NEVER appear in config files on disk.

| Provider | How It Works |
|----------|-------------|
| `env` | Read from environment variables (e.g., `LUMI_CLOUD_API_KEY`) |
| `file` | Read from a protected file (`.lumi_secrets`) with 600 permissions |
| `vault` | HashiCorp Vault integration |
| `aws_secrets` | AWS Secrets Manager |
| `azure_keyvault` | Azure Key Vault |

At startup:
```python
def resolve_secrets(config):
    if config.secrets.provider == "env":
        for field, env_var in config.secrets.key_mappings.items():
            value = os.environ.get(env_var)
            if not value:
                raise ConfigError(f"Missing env var: {env_var}")
            set_nested_field(config, field, value)
```

---

## 6. 📊 Example: Real-World Flow

```
User: "What's 2+2?"
  → complexity = 0.05 (trivial math)
  → routes to LOCAL (qwen2.5:7b)
  → response in 200ms
  → ✅ Fast, free, private

User: "Explain quantum entanglement and its implications for computing"
  → complexity = 0.72 (reasoning + domain knowledge)
  → routes to CLOUD (deepseek-chat)
  → response in 3s
  → ✅ Deep, accurate, comprehensive

[Internet drops]
  → latency_monitoring detects cloud timeout > 5s
  → auto-switches to local_first
  → all traffic goes to local until cloud recovers
  → ✅ Graceful degradation
```

---

## 7. 🚀 Implementation Roadmap

| Phase | What | Timeline |
|-------|------|----------|
| **P0** | JSON schema + config loader + `cloud_first`/`local_first` | Week 1 |
| **P1** | `auto` strategy with complexity scoring | Week 2 |
| **P2** | Latency monitoring + adaptive switching | Week 3 |
| **P3** | `hybrid` mode + response comparison | Week 4 |
| **P4** | `cost_optimized` mode + analytics dashboard | Week 5 |

---

*"The mark of intelligence is not knowing everything — it's knowing where to look. Local for reflex. Cloud for depth. Wisdom for choosing between them."*
