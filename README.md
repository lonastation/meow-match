# Meow Match

A complete, touch-first browser puzzle about making room for yarn. Slide rigid horizontal spools, let them fall, and fill all nine cells of a row to clear it. Rows clear in any colors. Three limited-use items help cut long spools, sweep away a color, and fill gaps. There is no rotation, merging, timer, backend, or account.

The game uses plain HTML, CSS, JavaScript, and Canvas. No build step, framework, external library, font, image, audio, CDN, or remote service is required. The cat illustrations and icons are local artwork. The original Android/Gradle starter was removed; Git history and the existing license were preserved.

## Files

```text
meow-match/
├── index.html              # Page, controls, score notice, and inline cat artwork
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
│   ├── items.test.cjs      # Item charges, resolution, and clear-time moves
│   ├── motion.test.cjs     # Continuous drop paths and collision invariants
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
- **Items:** Use the scissors, brush, and yarn-basket icons in the tray below the board. Each starts with **3 uses per game**, shown by its small count badge and restored on restart. Items are available when the board is idle. Successful uses add no move or incoming row; any resulting falls and clears resolve normally, including chain scoring. An item with nothing eligible to affect is disabled and costs nothing.
- **Spool Cutter:** Click the scissors once to cut **every length-4 spool into 2 + 2** and **every length-3 spool into 1 + 1 + 1** across the board. The entire action costs **one use**, regardless of how many spools are cut. The pieces retain their color and move independently. Lengths 1, 2, and 5 stay unchanged.
- **Color Sweep:** Randomly choose one of the colors currently on the board and remove **every spool of that color**. Removing spools itself awards no points; resulting full-row clears do.
- **Fill Five:** Add **5 single-cell spools** in empty spaces, or all remaining spaces when fewer than 5 are empty. Favor supported rows that can be completed with the remaining placements, starting with the fewest gaps and choosing randomly among ties. Otherwise choose random supported spaces. New spools have random colors, and normal gravity and row clearing follow.
- **Restart:** Use the circular-arrow icon beside the three items, then confirm a fresh game. After game over, use “One more purr.”

During a clear, you can drag **surviving spools horizontally**; the disappearing rows cannot be dragged. Every valid slide counts as a move and queues one new row. Falling, the pause before insertion, and insertion still lock input. If you are holding a spool when the clear ends, rows disappear and points are awarded on schedule, but gravity waits for release or cancellation. New drags cannot begin during that extra wait.

Interrupted gestures (for example, `pointercancel`, focus loss, or resizing during a drag) roll back the active drag without consuming a turn. During clearing, this does not cancel moves already committed or the ongoing resolution. The board uses device-pixel-ratio scaling for crisp drawing and resizes with the viewport. Canvas gestures suppress scrolling, pull-to-refresh, and text selection.

## Rules and deliberate choices

The board is exactly **9 columns × 12 rows**. Each cell stores either `null` or one spool ID; the associated metadata records its row, column, length, and color. Spools occupy one horizontal row and have lengths from 1 through 5. They keep their shape unless explicitly split with Spool Cutter. Every new game starts with exactly three randomized sparse bottom rows; the nine rows above them are empty. One shared empty column prevents an opening clear, and a supported column preserves the three-row stack after gravity settles the opening.

On phones, the page and game frame each use only 6px of horizontal padding (plus any device safe area). Every cell is square. The board uses the largest shared cell size that fits both the available width and height, keeping all nine columns and twelve rows visible. Spools and their full-cell touch targets scale together; the grid rules and horizontal movement are unchanged.

A valid turn follows this order:

1. Commit a horizontal move that ends at a different column.
2. Let **all spools** settle, including any spool whose support was removed by the drag. Each spool moves down one cell only when every cell directly below it is empty. One supporting cell stops the whole spool, so partial overhang is allowed.
3. After falling finishes, scan **the entire board** and collect **all full rows** before changing any cells. Clear that complete batch simultaneously in one animation, even when the rows are not adjacent, and award their points in one chain step. Other spools may be slid horizontally during this animation; no spool falls. After the batch disappears and any held drag finishes, apply gravity to **all remaining spools**, using their current columns. Repeat the whole-board scan after falling finishes again. Horizontal spools disappear as complete objects; rows are never compressed by shifting individual cells.
4. Only after the entire outcome is resolved, including every chain and score award, hold the stable board for **200 ms**, then reveal and insert **exactly one** new bottom row and move the existing board up one cell. This consumes one queued row. Each valid move gets one pause and insertion; no-op moves and top overflow skip them. The incoming row contains two or three independent spools, occupies four to eight cells, and always has an empty cell. The preview stays hidden during dragging, clearing, resolution, and the stationary pause; the incoming row reappears when insertion begins. Each following row is generated only after the preceding insertion's complete resolution.
5. If the upward shift would push any spool beyond the top, the game ends immediately, before any possible gravity rescue. The engine reports overflow without committing invalid coordinates.
6. Otherwise, apply gravity to all spools, then use the same whole-board scan and simultaneous batch clear described above. Repeat until stable. If moves made during clearing have queued more rows, repeat steps 4–6 for each. Return to idle when the queue is empty. Only one resolver runs; additional slides never start parallel gravity or insertion. Overflow discards all pending rows.

The first clear step awards **100 points per row**. Each subsequent chain step in that same resolution adds **50 points per row**: 100, 150, 200, and so on. Multiple rows cleared together use the same multiplier. The resolution before insertion and the resolution after insertion are separate chains, each starting at 100. A cat-themed score notice shows earned points at the top inside the board panel. Personal best is saved with `localStorage` when available; blocked storage does not prevent play. The current board and score are not saved between page loads.

The choices above resolve small ambiguities: clear-time moves join the current resolution and chain, with their extra rows deferred until that resolution finishes. This also applies to moves made during an item's clears: the item adds no row, but each valid slide still adds one. Cancelled or unchanged drags add no moves or rows; an already-running clear still finishes. The two sides of insertion use separate chain counters. There is no automatic pass or deadlock penalty. If no spool can move horizontally, the player can use an available item or restart.

New rows favor lengths **2–3**, keep occasional lengths 1, 4, and 5, and contain **at most one single-cell spool**. To prevent long-spool buildup, generation checks the current board: **while any length-4 spool remains, no new length-4 spool is generated**, and the same independent limit applies to length 5. Each generated row also contains at most one four. Once the existing long spool is cleared, cut, or swept away, that length becomes eligible again. This keeps at most one four and one five across the board and queued row in normal play, including the opening. The queued row is chosen after the board settles and stays fixed through moves and item uses; removing a long spool does not reroll an already shown preview.

The generator chooses from bounded, cached layouts of whole spools instead of scattering occupied cells and subdividing them. Layout weights are 1 for a row containing a four, 3 for a row containing a five, and 12 otherwise. Both initial rows and incoming rows use these constraints; the protected opening gap and support column are retained. If the long-spool limits make a sampled density impossible with at most three pieces, the generator reduces occupied cells only enough to find a valid layout, always keeping four to eight cells. A deterministic 10,000-row sample on an empty board produced about **6% length-4 spools**; actual proportions during play also depend on which spools remain on the board. Item-created fragments are exempt from generated-row limits.

## Implementation and tests

`engine.js` is independent of the DOM and rendering. It exposes `MeowEngine` in the browser and the same API through CommonJS for testing. `Board` starts empty; `reset()` creates an initial game. The grid is authoritative for occupancy, collisions, full rows, and support. `assertValid()` checks the spool-to-cell mapping. The controller separates idle input, dragging, clearing, resolution, insertion, and game over. `canBeginDrag` applies the same rules to pointer and keyboard input. Rendering uses `requestAnimationFrame` and short interpolated animations.

### Falling and rendering

Each gravity phase computes its final rigid-body positions using the grid, then animates **one continuous drop**. Each spool moves linearly at a constant speed for its own drop distance, starts immediately with the other falling spools, and stops at its own landing time. A short drop moves identically whether it falls alone or beside a longer drop. Vertical ordering and separation are preserved, including stacks and partial overhangs; there is no bounce, stretching, or camera movement.

For a distance of `d` cells, normal fall duration is `min(550, 250 × sqrt(d))` milliseconds: **250 ms** for one cell, about **354 ms** for two, **500 ms** for four, and **550 ms** for five through eleven. Scheduling and position sampling share one unrounded duration helper. Input stays locked until the longest drop finishes. After the move's complete resolution, a **200 ms** stationary pause separates it from the **180 ms** new-row rise, which retains its ease-out curve. Timing constants live together in `game.js`.

Completed rows remain fully opaque for **1,250 ms**, then fade together over another **150 ms**. During the hold, the completed rows automatically make **three diminishing left-and-back sweeps**, matching the reference video's sideways clear animation. All spools in all captured rows share one offset: 0, −A, 0, −A/2, 0, −A/4, 0 at 0, 250, 500, 700, 900, 1,075, and 1,250 ms, with cosine easing between positions. The first excursion A is **0.24 cell, capped at 8 CSS pixels**. They return to their original columns before the final fade. This is a rendering effect only: spool lengths, cell ownership, and every vertical position stay unchanged. The canvas clips the small edge overhang.

The board, steady row highlight, and score notice remain stationary. Surviving spools move only when dragged. The score notice overlays the top of the grid inside the board panel, without reserving layout space or intercepting pointer input. Showing or hiding it never moves the board, and game dialogs appear above it. It uses exactly the same hold/fade clock as the rows, with no pulsing flashes. Scoring advances when the entire batch disappears. Gravity resumes afterward, waiting for any held drag to finish. Full-row scanning still waits for the entire fall animation, and insertion still waits for all clears and chains.

These targets follow frame samples from the supplied reference video: roughly 250–300 ms for a short drop, 150–200 ms for a row rise, and 1.3–1.5 seconds for a clear. Those are estimates, and the 550 ms cap is a deliberate limit for longer drops. The reference video is analysis-only and is excluded from the offline cache and downloadable game bundle.

The grid background and yarn textures are drawn into local canvas caches at the current device pixel ratio. They are reused during motion and rebuilt when the canvas geometry or pixel ratio changes. Animation paths are prepared once per phase rather than allocating fresh board snapshots and lookup maps every frame. Repeated resize events with unchanged dimensions and pointer moves within the same column do not trigger extra updates.

Rendering runs only while something changes; there is no idle animation-frame loop. Switching away from the tab pauses the animation clock, so returning resumes motion instead of skipping to its last frame. Timing uses elapsed time rather than frame counts. Reduced-motion mode disables the automatic sideways clear sweep, compresses each fall to **35 ms** using common linear progress for every spool, and shortens insertion to **35 ms**. The full **1,400 ms** clear and **200 ms** stationary pause remain, so there is still time to read the result.

The game needs no Node.js installation. Developers who have Node.js can run the automated tests from the repository directory:

```sh
node --test tests/engine.test.cjs tests/controller.test.cjs tests/items.test.cjs tests/motion.test.cjs tests/browser-input.test.cjs
```

Tests cover geometry, contiguous drag limits, single-cell and stacked rigid gravity, partial support, color-independent full rows, chains, insertion, overflow, no-op behavior, scoring, long-spool generation limits, item eligibility and charges, and randomized invariant checks. Item tests verify splitting, complete color removal, supported gap filling, independent three-use limits, resets, and clear-time moves. Motion tests sample falling paths between cells to verify continuous travel and prevent visual overlaps. Browser tests run the real scripts in a mocked DOM/Canvas with a controlled animation clock to check frame cadence, caching, tab visibility, reduced motion, touch and mouse handling, resizing, one-click cutting of all eligible spools, item input locks, and disabled/exhausted controls. These are correctness and rendering-work checks, not measurements of Android GPU performance.

For a manual phone check, create a long drop and a chain clear. Watch the full rows automatically sweep left and back while other rows remain stationary; confirm reduced motion removes that sideways movement. Slide a surviving spool during the clear, hold it beyond the fade, and confirm gravity waits for release. Check that disappearing spools cannot be selected, every valid slide adds exactly one row, and falls/rises remain locked. Cancel a clear-time drag by switching tabs or rotating the phone, and reopen the cached app in airplane mode. Device frame-rate profiling should be done on the target Android phone; desktop or simulated frame timing cannot establish its actual FPS.

When changing cached app files for a new release, increment the cache version in `service-worker.js` so the next service-worker installation prepares a fresh complete local cache.
