# pi-peek

Peek is a [pi](https://github.com/mariozechner/pi) extension for browsing the current session scrollback in a keyboard-driven overlay.

https://raw.githubusercontent.com/Yeshwanthyk/pi-peek/main/media/demo.mp4

## Install

Recommended, via pi package install:

```sh
pi install git:github.com/Yeshwanthyk/pi-peek
```

Project-local install:

```sh
pi install -l git:github.com/Yeshwanthyk/pi-peek
```

Try for one run without installing:

```sh
pi -e git:github.com/Yeshwanthyk/pi-peek
```

After installing, run `/reload` in pi or restart pi.

### Manual install

```sh
git clone https://github.com/Yeshwanthyk/pi-peek ~/.pi/agent/extensions/peek
```

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

## Package metadata

This repo is a pi package. `package.json` declares:

```json
{
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./index.ts"],
    "video": "https://raw.githubusercontent.com/Yeshwanthyk/pi-peek/main/media/demo.mp4"
  }
}
```

That lets users install it with `pi install git:github.com/Yeshwanthyk/pi-peek` instead of manually copying files into `~/.pi/agent/extensions`.

## Security

Pi packages run with your local user permissions. Review third-party extensions before installing them.
