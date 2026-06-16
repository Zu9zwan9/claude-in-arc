"""claude-in-arc: run the official Claude extension in Arc."""

from .core import TOOL_VERSION, main

__all__ = ["main", "TOOL_VERSION"]
__version__ = TOOL_VERSION
