# Shadow of the Nile

A mobile, landscape-orientation, Assassin's Creed–style **stealth-action game set in modern-day Egypt**, playable in any browser — no install, no build step. Open `index.html` and play.

## The pitch

You are one of the hidden ones, operating in today's Egypt — Downtown Cairo, the Khan el-Khalili bazaar, Alexandria's Corniche, the Giza backstreets, Port Said's warehouses, Zamalek, Nasr City, old Luxor. Your contracts: antiquities smugglers, arms dealers, corrupt moguls, traffickers.

**Every contract is procedurally generated from an 8-digit contract number (seed):**

- the city district, street layout, buildings, courtyard compounds, bazaars and plazas
- the target's name, occupation and crime (mission fiction is assembled from parts)
- the objective — assassinate / recover stolen antiquities / free a hostage / burn smuggling caches
- time of day (dawn, day, dusk, night), weather (clear or khamaseen dust storm)
- guard count, patrol routes, bodyguards, hiding spots, parked cars, loot stashes

That's **100,000,000 distinct scenarios**. The same contract number always produces the same mission, so players can share seeds and compete on them.

## How to play

Played **rotated (landscape)** — a portrait phone shows a "rotate your device" prompt, and starting a mission requests fullscreen + landscape orientation lock.

| Action | Touch | Keyboard |
|---|---|---|
| Move | drag on left half (virtual joystick) | WASD / arrows |
| Strike / assassinate | ✝ button | Space / J |
| Sneak (crouch) | ▼ button | C / Shift |
| Use (steal, free, burn, loot) | ✋ button | E |
| Pause | ⏸ | Esc |

Guards have line-of-sight **vision cones** (white = calm, amber = suspicious, red = hunting). Strike unaware enemies from behind for silent kills. Crouch in cardboard/trash piles to vanish. Discovered corpses raise the alarm. Night and dust storms shrink enemy vision. Finish the objective, then escape via the glowing blue ankh — the brotherhood's extraction sign. Finish undetected for the **Silent Blade** bonus.

Progress (contracts fulfilled, best score) is saved locally.

## Running it

- Double-click `index.html`, or serve the folder (`npx http-server egypt-game`) and open it on your phone.
- Works offline; a single self-contained file with zero dependencies.

## Roadmap to a store-ready mobile game

This is the playable core. To ship on Google Play / App Store:

1. Wrap with [Capacitor](https://capacitorjs.com/) (`landscape` locked in the native config) for Android/iOS builds.
2. Add a PWA manifest + service worker for installable web play.
3. Content growth is cheap by design: new districts, objective types, target archetypes and modifiers each **multiply** the scenario count.
4. Longer term: port the same scenario-generator design to a 3D engine (Unity/Godot) for true AC-style parkour and combat.
