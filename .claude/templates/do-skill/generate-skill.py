#!/usr/bin/env python3

"""
Generate a /do skill from the template and configuration

Usage:
    python generate-skill.py <config-file> [output-file]

Examples:
    python generate-skill.py examples/sam-config.json
    python generate-skill.py my-config.json ../../commands/do.md
"""

import json
import os
import sys
from pathlib import Path

try:
    from pybars import Compiler
except ImportError:
    print("Error: pybars3 is required. Install with: pip install pybars3")
    sys.exit(1)


def main():
    # Parse command line arguments
    if len(sys.argv) < 2:
        print("Usage: python generate-skill.py <config-file> [output-file]")
        print("")
        print("Examples:")
        print("  python generate-skill.py examples/sam-config.json")
        print("  python generate-skill.py my-config.json ../../commands/do.md")
        sys.exit(1)

    config_file = sys.argv[1]
    output_file = sys.argv[2] if len(sys.argv) > 2 else "../../commands/do.md"

    # Check if config file exists
    if not os.path.exists(config_file):
        print(f"Error: Config file not found: {config_file}")
        sys.exit(1)

    # Load template
    template_path = Path(__file__).parent / "do-template.md"
    if not template_path.exists():
        print(f"Error: Template not found: {template_path}")
        sys.exit(1)

    print("Loading template...")
    with open(template_path, 'r') as f:
        template_source = f.read()

    # Load config
    print(f"Loading config from {config_file}...")
    with open(config_file, 'r') as f:
        config = json.load(f)

    # Compile and execute template
    print("Processing template...")
    compiler = Compiler()
    template = compiler.compile(template_source)
    output = template(config)

    # Ensure output directory exists
    output_path = Path(output_file)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Write output
    print(f"Writing to {output_file}...")
    with open(output_file, 'w') as f:
        f.write(output)

    print("✓ Done!")
    print("")
    print("Next steps:")
    print("  1. Review the generated file")
    print("  2. Test the workflow with a sample task")
    print("  3. Customize further if needed")


if __name__ == "__main__":
    main()
