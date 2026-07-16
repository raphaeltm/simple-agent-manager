PYTHON_SDK_PATH = "/opt/uv-tools/acp-amp/lib/python3.12/site-packages/acp_amp/driver/python_sdk.py"
AMP_TYPES_PATH = "/opt/uv-tools/acp-amp/lib/python3.12/site-packages/amp_sdk/types.py"

with open(PYTHON_SDK_PATH, encoding="utf-8") as handle:
    t = handle.read()
t = t.replace(
    "\"message\": str(exc)",
    "\"message\": str(exc) + (\" stderr: \" + exc.stderr if hasattr(exc, \"stderr\") and exc.stderr else \"\")",
)
old = '''        if mcp_config:
            base["mcp_config"] = mcp_config
            base["mcpConfig"] = mcp_config'''
new = '''        if mcp_config:
            from amp_sdk.types import MCPConfig
            cleaned = {}
            for _n, _c in mcp_config.items():
                if isinstance(_c, dict):
                    _cc = dict(_c)
                    if _cc.get("env") is None:
                        _cc["env"] = {}
                    cleaned[_n] = _cc
                else:
                    cleaned[_n] = _c
            _wrapped = MCPConfig(servers=cleaned)
            base["mcp_config"] = _wrapped
            base["mcpConfig"] = _wrapped'''
t = t.replace(old, new)
with open(PYTHON_SDK_PATH, "w", encoding="utf-8") as handle:
    handle.write(t)

with open(AMP_TYPES_PATH, encoding="utf-8") as handle:
    vt = handle.read()
vt = vt.replace(
    'visibility: Optional[Literal["private", "public", "workspace", "group"]] = "workspace"',
    'visibility: Optional[Literal["private", "public", "workspace", "group"]] = "private"',
)
with open(AMP_TYPES_PATH, "w", encoding="utf-8") as handle:
    handle.write(vt)
