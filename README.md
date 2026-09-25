# kaomoji board ( ˘ω˘ )

A tiny, fast kaomoji picker for Windows. It lives in your tray, pops up on a
global hotkey, and gets a kaomoji onto your clipboard (or straight into the app
you were typing in) in a couple of keystrokes.

**Ctrl+Alt+K** → type `shrug` → **Enter** → `¯\_(ツ)_/¯`

## Features

- **350+ kaomoji** in 23 categories, each with its own search keywords, so
  searches like `cat`, `hug`, `tea` or `table flip` find the right ones
- **Frequently Used** ranks what you actually use, and **Favorites** (click
  the heart or press Ctrl+D) keeps your go-tos at the top
- **Custom kaomoji** of your own, stored alongside the built-in ones
- **Paste into the last app** (optional): Enter pastes directly and puts your
  clipboard back afterwards
- **Keyboard-first**: arrow keys, 1–9 quick picks, Ctrl+K for actions,
  Ctrl+P to filter by category, Ctrl+Z to undo
- **Sync** favorites, custom kaomoji and history between computers by pointing
  it at a folder in any cloud drive
- **Stats**: your top kaomoji, streaks and a few fun facts
- Light and dark themes, compact tiles, launch at startup, remappable hotkey
- Updates itself from GitHub releases

## Install

Download the latest `kaomoji-board_x.y.z_x64-setup.exe` from
[Releases](https://github.com/alansolarski/kaomoji-board/releases) and run it.
It appears in the tray; press **Ctrl+Alt+K** to open it.

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| Ctrl+Alt+K | Open / close the board (configurable) |
| Type anything | Search |
| Enter | Copy (or paste, if enabled) the selected kaomoji |
| Ctrl+Enter | The other of copy / paste |
| 1–9 | Copy a numbered kaomoji (Ctrl+1–9 while searching) |
| Arrow keys, Tab | Move the selection |
| Ctrl+D | Favorite / unfavorite |
| Ctrl+K | Actions for the selected kaomoji |
| Ctrl+P | Filter by category |
| Ctrl+Z | Undo the last removal |
| Esc | Clear search → clear filter → close |

## Adding kaomoji

The library lives in [`src/kaomoji-data.js`](src/kaomoji-data.js). Each item
is either the kaomoji on its own or `["kaomoji", "extra search words"]`.
Pull requests with good additions are welcome.

## Building from source

Requires [Node.js](https://nodejs.org/) and [Rust](https://rustup.rs/).

```bash
npm install
npx tauri build
```

The installer ends up in `src-tauri/target/release/bundle/nsis/`.
The app icons are generated from `src-tauri/icons/source/*.svg` with
`python src-tauri/icons/source/build_icons.py`.

## Where your data lives

Favorites, custom kaomoji, usage and preferences are in
`%APPDATA%\com.kaomoji.board\data.json` (or in your chosen sync folder).
The hotkey and window position are in `config.json` next to it.

## License

[MIT](LICENSE)
