# pi-peek

Peek is a pi extension for browsing the current session scrollback in an overlay.

## Install

Clone into pi's global extension directory:

```sh
git clone https://github.com/Yeshwanthyk/pi-peek ~/.pi/agent/extensions/peek
```

Then run `/reload` in pi, or restart pi.

## Use

- `Ctrl+Shift+J`: open Peek
- `/peek`: open Peek
- `j` / `k`: scroll down/up
- `J` / `K`: jump next/previous message
- `g` / `G`: top/bottom
- `t`: toggle tool messages
- `/`, `n`, `N`: search
- `M`: copy current message
- `o`: view current message in nvim
- `O`: edit current assistant message in nvim
- `q` / `Esc`: close
