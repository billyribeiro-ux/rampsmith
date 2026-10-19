# The evaluation script Railway CLI 5.70.0 runs for a .py authoring file: the `script` string in
# `evaluate_python`, src/iac/eval.rs of the railwayapp 5.70.0 crate (crates.io checksum
# 419e90a9a0727d0cb218cc4dbed8da01ee7d820b989a0deb2dbeb09800e5a24a), copied verbatim so
# test_railway.py can prove the CLI reads railway.py. Refresh it when the CLI pin moves.
import importlib.util, inspect, json, os, sys
path = sys.argv[1]
payload = json.loads(os.environ.get("RAILWAY_IAC_CONTEXT") or "{}")

def make_ctx(payload):
    try:
        from railway_sdk import create_railway_context
        return create_railway_context(payload)
    except Exception:
        class _Shared:
            def __getattr__(self, name):
                if name.startswith("_"):
                    raise AttributeError(name)
                return {"type": "sharedReference", "name": name}
        class _Ctx(dict):
            def __init__(self, p):
                super().__init__(p)
                env = p.get("environment") or p.get("environmentName")
                self.environment = env
                self.environmentName = env
                self.shared = _Shared()
            def is_environment(self, name):
                return self.environment == name
            def random_string(self, label="random", bytes=12):
                import hashlib
                seed = f"railway-iac:{self.environment or 'default'}:{label}"
                return hashlib.sha256(seed.encode()).hexdigest()[: bytes * 2]
        return _Ctx(payload)

ctx = make_ctx(payload)
spec = importlib.util.spec_from_file_location("railway_sdk_user", path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
partial = getattr(mod, "PARTIAL", None) or getattr(mod, "Partial", None) or getattr(mod, "partial", None)
candidate = getattr(mod, "main", None) or getattr(mod, "Railway", None) or getattr(mod, "default", None)
if callable(candidate):
    try:
        params = list(inspect.signature(candidate).parameters.values())
    except (TypeError, ValueError):
        params = [None]
    project = candidate() if not params else candidate(ctx)
else:
    project = candidate
if hasattr(project, "to_graph"):
    project = project.to_graph()
print(json.dumps({"partial": partial, "project": project}, default=str))
