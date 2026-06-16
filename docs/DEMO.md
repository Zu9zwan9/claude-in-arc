# Recording the demo GIF

The README references `docs/demo.gif`. Record a short (5–10s) clip that tells the
whole story at a glance, then drop the file in here as `demo.gif`.

**Shot list:**
1. Arc open on any web page (e.g. a docs page or article).
2. Click the Claude toolbar icon (or press `Cmd+E`).
3. The Claude panel opens as a popup window.
4. Type "summarize this page" → show Claude responding with page context.

**Tips:**
- Keep it under ~6 MB so it renders fast on GitHub.
- macOS: record with `Cmd+Shift+5`, then convert to GIF (e.g. `ffmpeg -i in.mov -vf "fps=12,scale=900:-1:flags=lanczos" demo.gif`) or use Gifski for smaller files.
- A 2× retina capture downscaled to ~900px wide looks crisp in the README.
