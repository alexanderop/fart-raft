# Passed to Blender via `pnpm blender`: starts the MCP socket server (localhost:9876) once the UI is up,
# so Claude Code's `blender` MCP can connect without clicking "Start MCP Server" in the N panel.
import bpy


def _start():
    if hasattr(bpy.ops, "blendermcp"):
        bpy.ops.blendermcp.start_server()
        print("[fart-raft] Blender MCP server started on localhost:9876")
    else:
        print("[fart-raft] MCP for Blender addon not enabled; see CLAUDE.md")
    return None  # run once


bpy.app.timers.register(_start, first_interval=1.0)
