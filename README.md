# Meow Match

A complete, touch-first browser puzzle about making room for yarn. Slide rigid horizontal spools, let them fall, and fill all nine cells of a row to clear it. Colors are cosmetic. There is no matching by color, rotation, merging, splitting, timer, backend, or account.

The game uses plain HTML, CSS, JavaScript, and Canvas. No build step, framework, external library, font, image, audio, CDN, or remote service is required. The cat illustrations and icons are local artwork. The original Android/Gradle starter was removed; Git history and the existing license were preserved.

## Files

```text
meow-match/
├── index.html              # Page, controls, help, and inline cat artwork
├── style.css               # Responsive portrait layout and touch behavior
├── engine.js               # DOM-free grid, spool, gravity, and row rules
├── game.js                 # Pointer input, state machine, Canvas, animations, score
├── manifest.json           # Optional Android home-screen app metadata
├── service-worker.js       # Optional local-asset offline cache
├── assets/
│   ├── icon.svg
│   ├── icon-192.png
│   └── icon-512.png
├── tests/
│   ├── engine.test.cjs     # Rules, fixtures, and randomized invariant tests
│   ├── controller.test.cjs # Turn orchestration and scoring tests
│   └── browser-input.test.cjs # Pointer/resize regressions with a mocked DOM
├── README.md
└── LICENSE
```

## Run on a computer

Open `index.html` directly in a modern browser. Keep the other files and `assets/` folder beside it. No server or installation is necessary, and this local-file mode works without an internet connection. Service workers are intentionally skipped for `file://` URLs.

Alternatively, serve the directory with any static-file server. If Python is available, open a terminal in this directory and run:

```sh
python -m http.server 8080 --bind 0.0.0.0
```

Then open `http://localhost:8080/`. Python is an optional development tool; it is not a game dependency.

## Play on an Android phone

Use portrait orientation in Chrome or another current browser with Canvas and Pointer Events support.

**Local files:** Copy the entire game folder to the phone. Use a file manager to open `index.html` in the browser. File handling varies by Android version and file manager: the browser must receive access to the sibling CSS, JavaScript, and asset files. A file-manager preview that exposes only the HTML file cannot load the complete game. Where supported, this route requires no server or connection and works in airplane mode.

**Local Wi-Fi:** Start the static server above on your computer, connect both devices to the same network, and open `http://YOUR-COMPUTER-LAN-IP:8080/` on the phone. Allow inbound access to port 8080 if your computer's firewall asks. The game continues running in an already loaded tab after the connection is removed. Reloading a plain HTTP LAN address while disconnected is not guaranteed to work.

**Installable offline app:** Serve the same unchanged files from a trusted HTTPS origin, or use `http://localhost` on the phone itself. Chrome requires a secure context for service workers; a plain HTTP address such as `http://192.168.1.20:8080/` can run the game but does not provide the installable offline app. Load the page once, allow its local files to finish caching, then use Chrome's menu to install/add it to the home screen when offered. Launch it once to check installation before going offline. Once cached, the installed app and that supported origin can reopen in airplane mode. Clearing the site's storage also clears its offline cache and personal best.

All startup resources come from the local files or the same static origin. There are no third-party requests, analytics, accounts, API calls, or network activity during gameplay. The optional service worker uses `caches.addAll` to cache only the eight local game files listed in `service-worker.js`. It serves cached files without a network fallback, ignores other origins and paths outside this installation, and only deletes old caches belonging to this installation. Normal browser service-worker update checks are managed by the browser.

## Controls

- **Touch or mouse:** Press a spool, slide left or right, and release. Its row stays fixed during the drag. Spools stop at the board edges and adjacent spools; they cannot pass through another spool.
- **No-op:** Tap a spool or slide it back to its starting column before release. This costs no move, triggers no gravity, and inserts no row.
- **Keyboard:** Focus the board. Up/Down selects a spool, Left/Right slides it, Enter releases, and Escape cancels the move.
- **Help:** Use the `?` button for the rules.
- **Restart:** Use the circular-arrow button, then confirm a fresh game. After game over, use “One more purr.”

Input is locked during falling, clearing, scoring, and insertion. Interrupted pointer gestures (for example, `pointercancel`, focus loss, or resizing during a drag) roll back the active drag without consuming a turn. The board uses device-pixel-ratio scaling for crisp drawing and resizes with the viewport. Canvas gestures suppress scrolling, pull-to-refresh, and text selection.

## Rules and deliberate choices

The board is exactly **9 columns × 12 rows**. Each cell stores either `null` or one spool ID; the associated metadata records its row, column, length, and color. Spools occupy one horizontal row, have lengths from 1 through 5, and keep their shape for their entire lifetime. Every new game starts with exactly three randomized sparse bottom rows; the nine rows above them are empty. One shared empty column prevents an opening clear, and a supported column preserves the three-row stack after gravity settles the opening.

On phones, the page and game frame each use only 6px of horizontal padding (plus any device safe area). Every cell is square. The board uses the largest shared cell size that fits both the available width and height, keeping all nine columns and twelve rows visible. Spools and their full-cell touch targets scale together; the grid rules and horizontal movement are unchanged.

A valid turn follows this order:

1. Commit a horizontal move that ends at a different column.
2. Let **all spools** settle, including any spool whose support was removed by the drag. Each spool moves down one cell only when every cell directly below it is empty. One supporting cell stops the whole spool, so partial overhang is allowed.
3. After falling finishes, scan **the entire board** and collect **all full rows** before changing any cells. Clear that complete batch simultaneously in one animation, even when the rows are not adjacent, and award their points in one chain step. Only then apply gravity to **all remaining spools**. Repeat the whole-board scan after falling finishes again. Horizontal spools disappear as complete objects; rows are never compressed by shifting individual cells.
4. Only after the drag's entire outcome is resolved, including every chain and score award, reveal and insert **exactly one** new bottom row and move the existing board up one cell. The incoming row contains at least two independent spools, occupies four to eight cells, and always has an empty cell. The preview is hidden during dragging and resolution; the incoming row reappears when insertion begins. The following preview is generated and shown only after the complete turn finishes.
5. If the upward shift would push any spool beyond the top, the game ends immediately, before any possible gravity rescue. The engine reports overflow without committing invalid coordinates.
6. Otherwise, apply gravity to all spools, then use the same whole-board scan and simultaneous batch clear described above. Repeat until stable. Return control to the player without inserting another row.

The first clear step awards **100 points per row**. Each subsequent chain step in that same resolution adds **50 points per row**: 100, 150, 200, and so on. Multiple rows cleared together use the same multiplier. The resolution before insertion and the resolution after insertion are separate chains, each starting at 100. A cat-themed popup shows earned points. Personal best is saved with `localStorage` when available; blocked storage does not prevent play. The current board and score are not saved between page loads.

The choices above resolve small ambiguities: a committed drag, clearing, and insertion all resume gravity for the entire board; cancelled or unchanged drags do nothing; the two sides of insertion use separate chain counters. There is no automatic pass or deadlock penalty. If no spool can move horizontally, the player can restart.

## Implementation and tests

`engine.js` is independent of the DOM and rendering. It exposes `MeowEngine` in the browser and the same API through CommonJS for testing. `Board` starts empty; `reset()` creates an initial game. The grid is authoritative for occupancy, collisions, full rows, and support. `assertValid()` checks the spool-to-cell mapping. The controller separates idle input, dragging, resolution, insertion, and game over. Rendering uses `requestAnimationFrame` and short interpolated animations.

The game needs no Node.js installation. Developers who have Node.js can run the automated tests from the repository directory:

```sh
node --test tests/engine.test.cjs tests/controller.test.cjs tests/browser-input.test.cjs
```

Tests cover geometry, contiguous drag limits, single-cell and stacked rigid gravity, partial support, color-independent full rows, chains, insertion, overflow, no-op behavior, scoring, and randomized invariant checks. Input tests load the real scripts in a mocked DOM to check touch and mouse handling, cancellation, and resizing during a drag. For a manual mobile check, drag with one finger, verify input stays locked during animations, resize/rotate the phone, and reopen the cached app in airplane mode.

When changing cached app files for a new release, increment the cache version in `service-worker.js` so the next service-worker installation prepares a fresh complete local cache.
