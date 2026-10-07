# Notes for the next agent

Quake III Arena simulated in Firebird 6 (WASM) and painted in the browser. Read
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before touching the SQL; [docs/ROADMAP.md](docs/ROADMAP.md)
is the list of what is still missing against the real engine, in the order a player feels it. The
README is the public tour. Sibling projects by the same author: `../firebird-quake2`,
`../firebird-quake`, `../firebird-doom` (same architecture, each README links the next).

## The one rule

**Game logic goes in SQL, JavaScript only loads, forwards input and paints.** A feature that needs
state belongs in a table and a PSQL procedure; `src/scene.js` may keep cosmetic state (particles,
explosion sprites, beams) and nothing else. The renderers never query the database directly.

## Working on it

- `npm run check` compiles every SQL file into a fresh engine; run it after every SQL edit. It prints
  Firebird's error with the statement head; "Column unknown X" inside a procedure means a local used
  in a query without its colon.
- `npm test` (q3dm1 smoke), `npm run test:dm17` (jump pads), `npm run test:bots` (bots and the
  waypoint hunt), `npm run test:bots:dm17` (bots on the pads), `npm run test:pmove` (the movement against Quake III's
  `bg_pmove.c`), `npm run test:view` (the first-person
  view, seconds, no engine). All run against the real WASM engine in
  Node; CI runs all of them before deploying. Each takes one to two minutes.
- The pak is `public/pak/pak0.pk3`, fetched by `npm run fetch-pak` (gitignored). Four arenas:
  q3dm1 (the default, indoor, stairs), q3dm7 (big, many levels), q3dm17 (platforms over the void,
  every jump pad), q3tourney2.
- Headless pictures: `node scripts/screenshot.mjs <map> <prefix> --at=x,y,z,yaw --bright=4` then
  Read the PNGs. The live-site screenshot in the README was taken from the user's Chrome.
- Browser checks: the Claude desktop app's built-in browser pane cannot start Firebird WASM (it
  hangs at "Starting Firebird 6"). Use the user's Chrome (Claude-in-Chrome tools) against
  `PORT=8085 node scripts/build.mjs --serve --coi`; 8080 and 8081 are usually busy. A background tab
  throttles the loop to about one frame a second, so override `document.hidden` and, for anything
  heavy, run SQL through the page's console (`#sql`, `#run-sql`, `#sql-out`). Close the tab and stop
  the server (it is a `node scripts/build.mjs --serve` process) when done.
- Scratch files go in `.prof/` (gitignored): `wp.mjs` (graph stats and timing per map), `wpdiag.mjs`
  (graph components and the failed edges between them), `hunt.mjs` (a bot's route following tick by
  tick), `pad2.mjs` (every pad's flight), `fair.mjs` (how fast each skill kills a standing player).
  They are not in git; recreate from `scripts/bots-test.mjs` if missing.
- Tool quirk: long Python patches in a Bash heredoc have failed to parse twice in this environment
  (quotes in the body). Write the patch script with the Write tool into `.prof/` and run
  `python .prof/x.py`. Python 3 is on the PATH; `pkill` is not (use PowerShell `Stop-Process`).
- Commits: `git -c user.name="mariuz" -c user.email="mapopa@gmail.com" commit`, message in the
  style of `git log` (a title, then why and what, in prose), ending with the `Co-Authored-By:`
  trailer for the model doing the work (the session's system prompt gives it). Push to `main` deploys to
  https://mariuz.github.io/firebird-quake3/ through `.github/workflows/pages.yml` (about four minutes;
  `gh run watch <id> --exit-status`). Nothing is committed without the tests passing locally.

## Where things are

| Want to change | Look in |
| --- | --- |
| a table or column | `sql/schema.sql` (and `TABLES` in `src/loader.js` for the bulk-loaded ones) |
| collision, traces, slide/step moves | `sql/physics.sql` |
| the player's movement (substeps, gravity, `PM_CmdScale`) | `player_think` in `sql/player.sql`; `scripts/pmove-test.mjs` holds it against `bg_pmove.c` |
| movers, triggers, targets, items, damage, projectiles, map spawning | `sql/game.sql` |
| weapons, the player's think, respawn | `sql/player.sql` |
| bot behaviour, skill characteristics (`bot_char`) | `sql/bots.sql` |
| bot chat | `src/botchat.js` (the pak's botfiles into rows), `bot_say` and `bot_chat_event` at the top of `sql/bots.sql` |
| bot navigation (nodes, edges, routing, incremental build) | `sql/waypoints.sql`, `bot_follow_route` in `sql/bots.sql` |
| the tic entry point, think/physics dispatch, scoring, `init_map` | the end of `sql/bots.sql` |
| what a frame returns | `sql/render.sql` (`frame_all`), read in `src/scene.js` `FrameState.parse` |
| interpolation between tics, local prediction | `src/main.js`: `viewRow`, `interpolateFrame`, `poseOf`; the eye clamp in `view_setup` |
| view kicks, landing dips, bob, gun sway, zoom | `src/scene.js` `firstPersonView`, `zoomedFov`; the zoom key and sensitivity in `src/main.js` (tested by `npm run test:view`); the hit's source in `t_damage`, the fall's size in `impact` |
| what gets drawn and how | `src/scene.js` (what), `src/renderer.js` and `src/renderer-gl.js` (how) |
| HUD, icons, scoreboard | `src/hud.js` |
| sounds, music | `src/audio.js`; events are rows in `sound_events` written by `snd`/`snd_at` |
| the page, settings, input, the loop, the console | `src/main.js`, `public/index.html`, `public/style.css` |
| items, weapons, bot roster, player model | `src/gamedata.js` |
| pak parsing, BSP, MD3, shaders, images | `src/pk3.js`, `src/bsp.js`, `src/md3.js`, `src/shader.js`, `src/image.js` |

## Gotchas that cost hours

- Procedures and functions must exist before anything that references them; `game.sql` opens with
  forward declarations (empty bodies). `SQL_FILES` order in `src/loader.js` is load order; a new file
  goes where its dependencies are already defined (`waypoints` sits after `game`, before `bots`).
- `FIRST 1 SKIP (:k)` needs the parentheses. `OVER`, `COUNT`, `WAIT`, `RANDOM`, `TIME`, `VALUE` are
  reserved. `CASE`/`IIF` over string literals pads with spaces: `TRIM()` the result.
- Procedures with outputs: `EXECUTE PROCEDURE p(...) RETURNING_VALUES a, b` in PSQL; functions are
  expressions. Calling a function that does DML from a `WHERE` is asking for trouble.
- Global temporary tables (`wp_visit`, `clip_planes`, `pushed`, `sel_faces`) are emptied between the
  statements the page sends.
- A `WHILE` that steps a coordinate must provably advance (see `wp_scan_column`); an infinite loop in
  a procedure hangs the engine with no output and every test with it. If a test prints nothing for
  minutes, that is what happened: kill the `node` process (PowerShell `Stop-Process`) and look for the
  loop.
- Waypoint node heights are the point-trace floor + 25 (the box is only settled on slopes). A box
  dropped from above catches on railings and crate edges and puts nodes on top of them, which
  disconnects the graph (the symptom: "N of M nodes can reach the spawn" collapses).
- A trace that starts inside a brush returns `startsolid`; `wp_drop` turns it into −99999 so the
  column scan continues below instead of ending the column.
- `move_step` never walks off an edge (Quake 2 monsters did not jump down); a bot following a drop
  edge is launched by `bot_follow_route` setting its velocity instead. The bots tests are
  randomised by the spawn points: run a failing one four times in parallel
  (`for i in 1 2 3 4; do (node scripts/bots-test.mjs q3dm17 > .prof/h$i.txt 2>&1) & done; wait`)
  before deciding it is fixed, and replay a stall with `.prof/hunt.mjs <map> bx by bz px py pz`.
- `trace_move(NULL, …)` clips against the world, brush models and bounding-box entities (`solid` 2,
  3, 4) only; triggers and items (`solid` 1) are not obstacles.
- The jump pad's `target_position` is the apex of the throw, not the landing; the landing is found by
  flying the arc past it.
- The software painter's scratch buffers can grow mid-frame; take the reference after the growth.
- The WebGL and 2D contexts need separate canvases (`#screen`, `#glscreen`, `#overlay`); the input
  listens on the wrapper.
- The smoke test plays in god mode, and god mode returns from `t_damage` before anything is
  recorded: a check that needs real damage drops the flag for that tic (and holds the bots' fire),
  or calls `t_damage` with dflags 8, which goes through it.
- One statement may name tables at most 256 times ("Too many Contexts of Relation/Procedure/Views"):
  an `EXECUTE BLOCK` of INSERTs goes in blocks of 200.
- In CI the smoke test waits for the player to land (up to 60 tics) instead of counting tics; keep
  tests tolerant of timing, the engine is 10 to 20 percent slower there.
