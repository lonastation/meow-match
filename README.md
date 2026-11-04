# Meow Match

A touch-first puzzle game about making room for yarn. Slide horizontal spools left and right, let them fall, and fill all nine cells of a row to clear it. Clear rows in any colors you like.

**Play:** https://lonastation.github.io/meow-match/

## How to Play

The board is **9 columns × 12 rows**. Every spool lies flat in a single row and is 1–5 cells long.

- **Move a spool** by pressing it, sliding left or right, and releasing. It can't pass through other spools or leave the board.
- **Tap or slide back** to where you started and nothing happens — no move is spent.
- After every valid move, all spools fall straight down as far as they can. A spool only needs *one* cell of support to stay put, so overhangs are fine.
- When a row is completely filled, it clears. All full rows clear at once, and rows can chain.
- After everything settles, a new row rises from the bottom.

## Controls

| Action | Touch / Mouse | Keyboard |
|---|---|---|
| Select a spool | Press it | Up / Down |
| Slide it | Drag left or right | Left / Right |
| Release the move | Let go | Enter |
| Cancel the move | — | Escape |

The board must be focused for keyboard play. Interrupted gestures (a cancelled touch, losing focus, resizing mid-drag) roll the move back and cost you nothing.

## Items

You get **3 uses of each item per game**. They reset when you restart. Using an item never costs a move and never adds a row — but any falls or clears it causes score as normal. An item with nothing to do is disabled and won't be spent.

- **✂️ Spool Cutter** — Cuts every length-4 spool into two 2s, and every length-3 spool into three 1s. All at once, for a single use. The pieces keep their color and move independently. Lengths 1, 2, and 5 are untouched.
- **🖌️ Color Sweep** — Picks one color on the board at random and removes every spool of that color. The removals themselves score nothing, but the rows they complete do.
- **🧺 Fill Five** — Adds 5 single-cell spools into empty spaces (or every remaining space, if fewer than 5). It favors rows that are close to completion. Colors are random.

## Clearing and Scoring

- Clearing **one row** earns **100 points**.
- Each additional chain step in the same resolution is worth **50 more per row**: 100, then 150, then 200…
- Rows cleared together in one step all use the same value.
- The resolution before a new row arrives and the one after are separate chains — each starts back at 100.

While rows are clearing, you can still slide the spools that *aren't* disappearing. Each of those slides counts as a move and queues a new row, which arrives once the current resolution finishes. The clearing rows themselves can't be moved.

Your **personal best** is saved in your browser when storage is available.

## Game Over

If a new row would push any spool past the top of the board, the game ends — no lucky rescue. Clear space, use an item, or start fresh.

Tap the **circular arrow** next to the items (and confirm) to restart at any time.
