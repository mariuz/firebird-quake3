// gamedata.js – the data tables of the game module: bg_misc.c's item list
// (models, pickup sounds, icons, quantities, respawn times), the weapons
// (p_weapon / g_weapon numbers, models in hand, HUD icons), the bots of the
// demo and the player animation names. loader.js copies the items into
// ITEM_DEFS so the PSQL side is data-driven.

// weapon bits (1 << (WP_* - 1)) and the ammo index each uses
export const WP = { GAUNTLET: 1, MACHINEGUN: 2, SHOTGUN: 4, GRENADE: 8, ROCKET: 16, LIGHTNING: 32, RAILGUN: 64, PLASMA: 128, BFG: 256 };

export const WEAPONS = {
  1: { name: 'Gauntlet', model: 'models/weapons2/gauntlet/gauntlet.md3', icon: 'icons/iconw_gauntlet', ammo: 0, fire: 0.4, dmg: 50, sound: 'sound/weapons/melee/fstatck.wav', idle: 'sound/weapons/melee/fsthum.wav' },
  2: { name: 'Machinegun', model: 'models/weapons2/machinegun/machinegun.md3', icon: 'icons/iconw_machinegun', ammo: 2, fire: 0.1, dmg: 7, sound: 'sound/weapons/machinegun/machgf1b.wav' },
  4: { name: 'Shotgun', model: 'models/weapons2/shotgun/shotgun.md3', icon: 'icons/iconw_shotgun', ammo: 3, fire: 1, dmg: 10, sound: 'sound/weapons/shotgun/sshotf1b.wav' },
  8: { name: 'Grenade Launcher', model: 'models/weapons2/grenadel/grenadel.md3', icon: 'icons/iconw_grenade', ammo: 4, fire: 0.8, dmg: 100, sound: 'sound/weapons/grenade/grenlf1a.wav' },
  16: { name: 'Rocket Launcher', model: 'models/weapons2/rocketl/rocketl.md3', icon: 'icons/iconw_rocket', ammo: 5, fire: 0.8, dmg: 100, sound: 'sound/weapons/rocket/rocklf1a.wav' },
  32: { name: 'Lightning Gun', model: 'models/weapons2/lightning/lightning.md3', icon: 'icons/iconw_lightning', ammo: 6, fire: 0.05, dmg: 8, sound: 'sound/weapons/lightning/lg_fire.wav', idle: 'sound/weapons/lightning/lg_hum.wav' },
  64: { name: 'Railgun', model: 'models/weapons2/railgun/railgun.md3', icon: 'icons/iconw_railgun', ammo: 7, fire: 1.5, dmg: 100, sound: 'sound/weapons/railgun/railgf1a.wav', idle: 'sound/weapons/railgun/rg_hum.wav' },
  128: { name: 'Plasma Gun', model: 'models/weapons2/plasma/plasma.md3', icon: 'icons/iconw_plasma', ammo: 8, fire: 0.1, dmg: 20, sound: 'sound/weapons/plasma/hyprbf1a.wav' },
  256: { name: 'BFG10K', model: 'models/weapons2/bfg/bfg.md3', icon: 'icons/iconw_bfg', ammo: 9, fire: 0.2, dmg: 100, sound: 'sound/weapons/bfg/bfg_fire.wav' },
};
export const AMMO_NAMES = { 2: 'bullets', 3: 'shells', 4: 'grenades', 5: 'rockets', 6: 'lightning', 7: 'slugs', 8: 'cells', 9: 'bfg' };
export const AMMO_ICONS = { 2: 'icons/icona_machinegun', 3: 'icons/icona_shotgun', 4: 'icons/icona_grenade', 5: 'icons/icona_rocket', 6: 'icons/icona_lightning', 7: 'icons/icona_railgun', 8: 'icons/icona_plasma', 9: 'icons/icona_bfg' };

// bg_itemlist: kind H health A armor W weapon M ammo P powerup O holdable
export const ITEMS = [
  { cls: 'item_armor_shard', kind: 'A', models: 'models/powerups/armor/shard.md3,models/powerups/armor/shard_sphere.md3', snd: 'sound/misc/ar1_pkup.wav', icon: 'icons/iconr_shard', name: 'Armor Shard', qty: 5, respawn: 25 },
  { cls: 'item_armor_combat', kind: 'A', models: 'models/powerups/armor/armor_yel.md3', snd: 'sound/misc/ar2_pkup.wav', icon: 'icons/iconr_yellow', name: 'Armor', qty: 50, respawn: 25 },
  { cls: 'item_armor_body', kind: 'A', models: 'models/powerups/armor/armor_red.md3', snd: 'sound/misc/ar2_pkup.wav', icon: 'icons/iconr_red', name: 'Heavy Armor', qty: 100, respawn: 25 },
  { cls: 'item_health_small', kind: 'H', models: 'models/powerups/health/small_cross.md3,models/powerups/health/small_sphere.md3', snd: 'sound/items/s_health.wav', icon: 'icons/iconh_green', name: '5 Health', qty: 5, respawn: 35 },
  { cls: 'item_health', kind: 'H', models: 'models/powerups/health/medium_cross.md3,models/powerups/health/medium_sphere.md3', snd: 'sound/items/n_health.wav', icon: 'icons/iconh_yellow', name: '25 Health', qty: 25, respawn: 35 },
  { cls: 'item_health_large', kind: 'H', models: 'models/powerups/health/large_cross.md3,models/powerups/health/large_sphere.md3', snd: 'sound/items/l_health.wav', icon: 'icons/iconh_red', name: '50 Health', qty: 50, respawn: 35 },
  { cls: 'item_health_mega', kind: 'H', models: 'models/powerups/health/mega_cross.md3,models/powerups/health/mega_sphere.md3', snd: 'sound/items/m_health.wav', icon: 'icons/iconh_mega', name: 'Mega Health', qty: 100, respawn: 35 },
  { cls: 'weapon_gauntlet', kind: 'W', models: 'models/weapons2/gauntlet/gauntlet.md3', snd: 'sound/misc/w_pkup.wav', icon: 'icons/iconw_gauntlet', name: 'Gauntlet', qty: 0, respawn: 5, bit: 1 },
  { cls: 'weapon_shotgun', kind: 'W', models: 'models/weapons2/shotgun/shotgun.md3', snd: 'sound/misc/w_pkup.wav', icon: 'icons/iconw_shotgun', name: 'Shotgun', qty: 10, respawn: 5, bit: 4 },
  { cls: 'weapon_machinegun', kind: 'W', models: 'models/weapons2/machinegun/machinegun.md3', snd: 'sound/misc/w_pkup.wav', icon: 'icons/iconw_machinegun', name: 'Machinegun', qty: 40, respawn: 5, bit: 2 },
  { cls: 'weapon_grenadelauncher', kind: 'W', models: 'models/weapons2/grenadel/grenadel.md3', snd: 'sound/misc/w_pkup.wav', icon: 'icons/iconw_grenade', name: 'Grenade Launcher', qty: 10, respawn: 5, bit: 8 },
  { cls: 'weapon_rocketlauncher', kind: 'W', models: 'models/weapons2/rocketl/rocketl.md3', snd: 'sound/misc/w_pkup.wav', icon: 'icons/iconw_rocket', name: 'Rocket Launcher', qty: 10, respawn: 5, bit: 16 },
  { cls: 'weapon_lightning', kind: 'W', models: 'models/weapons2/lightning/lightning.md3', snd: 'sound/misc/w_pkup.wav', icon: 'icons/iconw_lightning', name: 'Lightning Gun', qty: 100, respawn: 5, bit: 32 },
  { cls: 'weapon_railgun', kind: 'W', models: 'models/weapons2/railgun/railgun.md3', snd: 'sound/misc/w_pkup.wav', icon: 'icons/iconw_railgun', name: 'Railgun', qty: 10, respawn: 5, bit: 64 },
  { cls: 'weapon_plasmagun', kind: 'W', models: 'models/weapons2/plasma/plasma.md3', snd: 'sound/misc/w_pkup.wav', icon: 'icons/iconw_plasma', name: 'Plasma Gun', qty: 50, respawn: 5, bit: 128 },
  { cls: 'weapon_bfg', kind: 'W', models: 'models/weapons2/bfg/bfg.md3', snd: 'sound/misc/w_pkup.wav', icon: 'icons/iconw_bfg', name: 'BFG10K', qty: 20, respawn: 5, bit: 256 },
  { cls: 'ammo_shells', kind: 'M', models: 'models/powerups/ammo/shotgunam.md3', snd: 'sound/misc/am_pkup.wav', icon: 'icons/icona_shotgun', name: 'Shells', qty: 10, respawn: 40, bit: 3 },
  { cls: 'ammo_bullets', kind: 'M', models: 'models/powerups/ammo/machinegunam.md3', snd: 'sound/misc/am_pkup.wav', icon: 'icons/icona_machinegun', name: 'Bullets', qty: 50, respawn: 40, bit: 2 },
  { cls: 'ammo_grenades', kind: 'M', models: 'models/powerups/ammo/grenadeam.md3', snd: 'sound/misc/am_pkup.wav', icon: 'icons/icona_grenade', name: 'Grenades', qty: 5, respawn: 40, bit: 4 },
  { cls: 'ammo_cells', kind: 'M', models: 'models/powerups/ammo/plasmaam.md3', snd: 'sound/misc/am_pkup.wav', icon: 'icons/icona_plasma', name: 'Cells', qty: 30, respawn: 40, bit: 8 },
  { cls: 'ammo_lightning', kind: 'M', models: 'models/powerups/ammo/lightningam.md3', snd: 'sound/misc/am_pkup.wav', icon: 'icons/icona_lightning', name: 'Lightning', qty: 60, respawn: 40, bit: 6 },
  { cls: 'ammo_rockets', kind: 'M', models: 'models/powerups/ammo/rocketam.md3', snd: 'sound/misc/am_pkup.wav', icon: 'icons/icona_rocket', name: 'Rockets', qty: 5, respawn: 40, bit: 5 },
  { cls: 'ammo_slugs', kind: 'M', models: 'models/powerups/ammo/railgunam.md3', snd: 'sound/misc/am_pkup.wav', icon: 'icons/icona_railgun', name: 'Slugs', qty: 10, respawn: 40, bit: 7 },
  { cls: 'ammo_bfg', kind: 'M', models: 'models/powerups/ammo/bfgam.md3', snd: 'sound/misc/am_pkup.wav', icon: 'icons/icona_bfg', name: 'Bfg Ammo', qty: 15, respawn: 40, bit: 9 },
  { cls: 'holdable_teleporter', kind: 'O', models: 'models/powerups/holdable/teleporter.md3', snd: 'sound/items/holdable.wav', icon: 'icons/teleporter', name: 'Personal Teleporter', qty: 60, respawn: 60, bit: 1 },
  { cls: 'holdable_medkit', kind: 'O', models: 'models/powerups/holdable/medkit.md3,models/powerups/holdable/medkit_sphere.md3', snd: 'sound/items/holdable.wav', icon: 'icons/medkit', name: 'Medkit', qty: 60, respawn: 60, bit: 2 },
  { cls: 'item_quad', kind: 'P', models: 'models/powerups/instant/quad.md3,models/powerups/instant/quad_ring.md3', snd: 'sound/items/quaddamage.wav', icon: 'icons/quad', name: 'Quad Damage', qty: 30, respawn: 120, bit: 1 },
  { cls: 'item_enviro', kind: 'P', models: 'models/powerups/instant/enviro.md3,models/powerups/instant/enviro_ring.md3', snd: 'sound/items/protect.wav', icon: 'icons/envirosuit', name: 'Battle Suit', qty: 30, respawn: 120, bit: 2 },
  { cls: 'item_haste', kind: 'P', models: 'models/powerups/instant/haste.md3,models/powerups/instant/haste_ring.md3', snd: 'sound/items/haste.wav', icon: 'icons/haste', name: 'Speed', qty: 30, respawn: 120, bit: 4 },
  { cls: 'item_invis', kind: 'P', models: 'models/powerups/instant/invis.md3,models/powerups/instant/invis_ring.md3', snd: 'sound/items/invisibility.wav', icon: 'icons/invis', name: 'Invisibility', qty: 30, respawn: 120, bit: 8 },
  { cls: 'item_regen', kind: 'P', models: 'models/powerups/instant/regen.md3,models/powerups/instant/regen_ring.md3', snd: 'sound/items/regeneration.wav', icon: 'icons/regen', name: 'Regeneration', qty: 30, respawn: 120, bit: 16 },
  { cls: 'item_flight', kind: 'P', models: 'models/powerups/instant/flight.md3,models/powerups/instant/flight_ring.md3', snd: 'sound/items/flight.wav', icon: 'icons/flight', name: 'Flight', qty: 60, respawn: 120, bit: 32 },
];

// The bots of the demo (scripts/bots.txt), as the arena has them: a model, a skin, a name
export const BOTS = [
  { name: 'Sarge', model: 'sarge', skin: 'default', skill: 2 },
  { name: 'Grunt', model: 'grunt', skin: 'default', skill: 2 },
  { name: 'Major', model: 'major', skin: 'default', skill: 2 },
  { name: 'Visor', model: 'visor', skin: 'default', skill: 3 },
  { name: 'Daemia', model: 'major', skin: 'daemia', skill: 3 },
  { name: 'Stripe', model: 'grunt', skin: 'stripe', skill: 1 },
];

export const PLAYER_MODEL = 'sarge';
