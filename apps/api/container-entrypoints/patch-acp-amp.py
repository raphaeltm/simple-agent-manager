from pathlib import Path

base = Path('/opt/uv-tools/acp-amp/lib/python3.12/site-packages')
p = base / 'acp_amp/driver/python_sdk.py'
t = p.read_text()
t = t.replace('"message": str(exc)', '"message": str(exc) + (" stderr: " + exc.stderr if hasattr(exc, "stderr") and exc.stderr else "")')
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
p.write_text(t)
v = base / 'amp_sdk/types.py'
vt = v.read_text().replace('visibility: Optional[Literal["private", "public", "workspace", "group"]] = "workspace"', 'visibility: Optional[Literal["private", "public", "workspace", "group"]] = "private"')
v.write_text(vt)
