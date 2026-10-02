#!/usr/bin/env python3
"""
Topology and ownership loader for AIRP Knowledge Plane (Chapter 4).
Loads infra/topology.yaml and infra/ownership.yaml.
Supports services, edges, CODEOWNERS-style owners, and on-call names.
"""

import fnmatch
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

try:
    import yaml  # type: ignore
    HAS_YAML = True
except ImportError:
    HAS_YAML = False


def _simple_yaml_parse(content: str) -> Dict[str, Any]:
    """Fallback YAML parser for simple YAML structures without external dependencies."""
    lines = content.splitlines()
    root: Dict[str, Any] = {}
    stack: List[tuple] = [(-1, root)]  # (indent, container)

    def current_container():
        return stack[-1][1]

    i = 0
    while i < len(lines):
        raw_line = lines[i]
        line = raw_line.split("#")[0].rstrip()
        if not line.strip():
            i += 1
            continue

        indent = len(line) - len(line.lstrip())
        stripped = line.strip()

        # Pop stack to parent level
        while len(stack) > 1 and indent <= stack[-1][0]:
            stack.pop()

        target = current_container()

        if stripped.startswith("- "):
            val = stripped[2:].strip().strip('"').strip("'")
            if ":" in val:
                # inline dict in list item e.g. - pattern: "..."
                key, rest = val.split(":", 1)
                item_dict = {key.strip(): rest.strip().strip('"').strip("'")}
                if isinstance(target, list):
                    target.append(item_dict)
                    stack.append((indent, item_dict))
                elif isinstance(target, dict):
                    pass
            else:
                if isinstance(target, list):
                    target.append(val)
                elif isinstance(target, dict):
                    # In case target is dict but got list item
                    pass
        elif ":" in stripped:
            key, val = stripped.split(":", 1)
            key = key.strip().strip('"').strip("'")
            val = val.strip()

            if val == "" or val == "[]" or val == "{}":
                # Container definition
                next_is_list = False
                if val == "[]":
                    new_container: Any = []
                elif val == "{}":
                    new_container = {}
                else:
                    # Look ahead to see if next line is a list item or map
                    j = i + 1
                    while j < len(lines):
                        next_line = lines[j].split("#")[0].rstrip()
                        if next_line.strip():
                            next_indent = len(next_line) - len(next_line.lstrip())
                            if next_indent > indent and next_line.strip().startswith("- "):
                                next_is_list = True
                            break
                        j += 1
                    new_container = [] if next_is_list else {}

                if isinstance(target, dict):
                    target[key] = new_container
                elif isinstance(target, list) and len(target) > 0 and isinstance(target[-1], dict):
                    target[-1][key] = new_container
                stack.append((indent, new_container))
            else:
                if val.startswith("[") and val.endswith("]"):
                    try:
                        val = json.loads(val)
                    except Exception:
                        pass
                else:
                    val = val.strip('"').strip("'")
                if isinstance(target, dict):
                    target[key] = val
                elif isinstance(target, list) and len(target) > 0 and isinstance(target[-1], dict):
                    target[-1][key] = val
        i += 1

    return root


def load_yaml_file(file_path: str) -> Dict[str, Any]:
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()
    if HAS_YAML:
        return yaml.safe_load(content) or {}
    return _simple_yaml_parse(content)


class KnowledgeTopology:
    """Manages topology and ownership graphs."""

    def __init__(self, topology_path: Optional[str] = None, ownership_path: Optional[str] = None):
        base_dir = Path(__file__).resolve().parent.parent.parent
        self.topology_path = topology_path or os.environ.get(
            "TOPOLOGY_PATH", str(base_dir / "infra" / "topology.yaml")
        )
        self.ownership_path = ownership_path or os.environ.get(
            "OWNERSHIP_PATH", str(base_dir / "infra" / "ownership.yaml")
        )
        self.services: Dict[str, Dict[str, Any]] = {}
        self.edges: List[Dict[str, str]] = []
        self.codeowners: List[Dict[str, Any]] = []
        self.reload()

    def reload(self) -> None:
        """Reloads topology and ownership from YAML files."""
        # 1. Load topology
        topo_data = load_yaml_file(self.topology_path)
        raw_services = topo_data.get("services", {})
        self.services = {}
        self.edges = []

        for svc_name, svc_info in raw_services.items():
            downstream = svc_info.get("downstream", []) if isinstance(svc_info, dict) else []
            self.services[svc_name] = {
                "name": svc_name,
                "downstream": downstream,
                "upstream": [],
                "owners": [],
                "team": None,
                "on_call": None,
                "paths": [],
            }
            for ds in downstream:
                self.edges.append({"from": svc_name, "to": ds})

        # Calculate upstream relationships
        for edge in self.edges:
            caller = edge["from"]
            callee = edge["to"]
            if callee in self.services:
                self.services[callee]["upstream"].append(caller)

        # 2. Load ownership
        if os.path.exists(self.ownership_path):
            owner_data = load_yaml_file(self.ownership_path)
            for svc_name, info in owner_data.get("services", {}).items():
                if svc_name not in self.services:
                    self.services[svc_name] = {
                        "name": svc_name,
                        "downstream": [],
                        "upstream": [],
                        "owners": [],
                        "team": None,
                        "on_call": None,
                        "paths": [],
                    }
                self.services[svc_name]["team"] = info.get("team")
                self.services[svc_name]["owners"] = info.get("owners", [])
                self.services[svc_name]["on_call"] = info.get("on_call")
                self.services[svc_name]["paths"] = info.get("paths", [])

            self.codeowners = owner_data.get("codeowners", [])

    def get_service(self, service_name: str) -> Optional[Dict[str, Any]]:
        return self.services.get(service_name)

    def get_downstream(self, service_name: str) -> List[str]:
        svc = self.services.get(service_name)
        return svc["downstream"] if svc else []

    def get_upstream(self, service_name: str) -> List[str]:
        svc = self.services.get(service_name)
        return svc["upstream"] if svc else []

    def get_on_call(self, service_name: str) -> Optional[Dict[str, Any]]:
        svc = self.services.get(service_name)
        return svc.get("on_call") if svc else None

    def get_owner_for_path(self, file_path: str) -> Dict[str, Any]:
        """Finds matching CODEOWNERS entry for a given file path."""
        normalized = file_path.strip("/")
        for entry in self.codeowners:
            pattern = entry.get("pattern", "").strip("/")
            if fnmatch.fnmatch(normalized, pattern) or fnmatch.fnmatch(
                normalized, pattern.replace("/**", "/*")
            ):
                return {
                    "service": entry.get("service"),
                    "owners": entry.get("owners", []),
                    "pattern": entry.get("pattern"),
                }
        # Fallback to service path matching
        for svc_name, svc_info in self.services.items():
            for p in svc_info.get("paths", []):
                norm_p = p.strip("/")
                if fnmatch.fnmatch(normalized, norm_p) or fnmatch.fnmatch(
                    normalized, norm_p.replace("/**", "/*")
                ):
                    return {
                        "service": svc_name,
                        "owners": svc_info.get("owners", []),
                        "team": svc_info.get("team"),
                    }
        return {"service": None, "owners": [], "team": None}

    def to_dict(self) -> Dict[str, Any]:
        return {
            "services": self.services,
            "edges": self.edges,
            "codeowners": self.codeowners,
        }


def main():
    topo = KnowledgeTopology()
    data = topo.to_dict()
    print(json.dumps(data, indent=2))


if __name__ == "__main__":
    main()
