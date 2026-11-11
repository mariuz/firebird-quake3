// intents.js – what a player can say to the bots, as botlib's match templates have it (match.c: MSG_HELP,
// MSG_ACCOMPANY, MSG_CAMP, MSG_GETITEM, MSG_KILL, MSG_DISMISS, MSG_WHEREAREYOU, MSG_WHATAREYOUDOING …): each
// intent with a few ways of saying it. botlib matches the words; here the phrases are embedded once
// (scripts/embed-intents.mjs, EmbeddingGemma 2) and what the player types is matched to the nearest by meaning
// (player_say in sql/chat.sql). `arg` is the item's class for "get" and for "defend" (MSG_DEFENDKEYAREA: the
// item's place is guarded); whoisleader, iamleader and notleader are MSG_WHOISTEAMLAEDER, MSG_STARTTEAMLEADERSHIP
// and MSG_STOPTEAMLEADERSHIP as the player says them of itself.
export const INTENTS = [
  { kind: 'accompany', phrases: ['follow me', 'come with me', 'stay with me', 'escort me', 'cover me', 'I need backup, come here', 'Visor, follow me', 'Major stay close to me'] },
  { kind: 'camp', phrases: ['camp here', 'hold this position', 'stay here and guard this spot', 'defend this place', 'wait here', 'Visor camp at this spot'] },
  { kind: 'dismiss', phrases: ['dismissed', 'stop following me', 'you are free to go', 'do what you want', 'forget your orders', 'at ease', 'Visor, you are dismissed'] },
  { kind: 'kill', phrases: ['kill him', 'attack that player', 'go after the enemy and frag him', 'hunt him down', 'take him out', 'kill Visor', 'Major, go frag Sarge'] },
  { kind: 'whereareyou', phrases: ['where are you?', 'what is your position?', 'tell me your location', 'where did you go?'] },
  { kind: 'whatareyoudoing', phrases: ['what are you doing?', 'what are you up to?', 'report your status', 'what is your task?'] },
  { kind: 'hello', phrases: ['hello', 'hi there', 'good morning everyone', 'hey guys'] },
  { kind: 'taunt', phrases: ['you suck', 'you are a terrible player', 'is that all you have got?', 'I will destroy you'] },
  { kind: 'praise', phrases: ['nice shot', 'well played', 'good game', 'thank you', 'great job'] },
  // (small talk: nothing is asked of anyone)
  { kind: 'chat', phrases: ['the weather is nice today', 'I like this map', 'lol', 'that was close', 'I am hungry', 'what a game', 'this level is hard', 'be right back'] },
  { kind: 'get', arg: 'weapon_rocketlauncher', phrases: ['get the rocket launcher', 'grab the rockets gun', 'go pick up the RL'] },
  { kind: 'get', arg: 'weapon_railgun', phrases: ['get the railgun', 'go for the rail gun', 'pick up the sniper weapon', 'grab the railgun for yourself', 'someone take the rail'] },
  { kind: 'get', arg: 'weapon_shotgun', phrases: ['get the shotgun', 'grab the shotgun'] },
  { kind: 'get', arg: 'weapon_plasmagun', phrases: ['get the plasma gun', 'grab the plasma rifle'] },
  { kind: 'get', arg: 'weapon_lightning', phrases: ['get the lightning gun', 'grab the shaft'] },
  { kind: 'get', arg: 'weapon_grenadelauncher', phrases: ['get the grenade launcher', 'grab the grenades gun'] },
  { kind: 'get', arg: 'weapon_bfg', phrases: ['get the BFG', 'grab the big gun, the BFG10K'] },
  { kind: 'get', arg: 'item_quad', phrases: ['get the quad damage', 'go for the quad', 'grab the damage powerup'] },
  { kind: 'get', arg: 'item_armor_body', phrases: ['get the red armor', 'grab the heavy armor', 'pick up the body armor'] },
  { kind: 'get', arg: 'item_armor_combat', phrases: ['get the yellow armor', 'grab the combat armor'] },
  { kind: 'get', arg: 'item_health_mega', phrases: ['get the mega health', 'grab the megahealth'] },
  { kind: 'get', arg: 'item_health', phrases: ['get some health', 'go heal yourself', 'pick up a medkit, you are hurt'] },
  { kind: 'get', arg: 'item_haste', phrases: ['get the haste', 'grab the speed powerup'] },
  { kind: 'get', arg: 'item_regen', phrases: ['get the regeneration', 'grab the regen powerup'] },
  { kind: 'get', arg: 'item_invis', phrases: ['get the invisibility', 'grab the invisibility powerup'] },
  { kind: 'get', arg: 'item_enviro', phrases: ['get the battle suit', 'grab the environment suit'] },
  { kind: 'defend', arg: 'weapon_rocketlauncher', phrases: ['defend the rocket launcher', 'guard the rocket launcher', 'Visor, defend the rocket launcher'] },
  { kind: 'defend', arg: 'weapon_railgun', phrases: ['defend the railgun', 'guard the railgun'] },
  { kind: 'defend', arg: 'weapon_plasmagun', phrases: ['defend the plasma gun', 'guard the plasma gun'] },
  { kind: 'defend', arg: 'weapon_lightning', phrases: ['defend the lightning gun', 'guard the lightning gun'] },
  { kind: 'defend', arg: 'item_quad', phrases: ['defend the quad damage', 'guard the quad'] },
  { kind: 'defend', arg: 'item_armor_body', phrases: ['defend the red armor', 'guard the heavy armor'] },
  { kind: 'defend', arg: 'item_armor_combat', phrases: ['defend the yellow armor', 'guard the combat armor'] },
  { kind: 'defend', arg: 'item_health_mega', phrases: ['defend the mega health', 'guard the megahealth'] },
  { kind: 'whoisleader', phrases: ['who is the leader?', 'who is the team leader?', 'is there a leader?', 'who leads this team?'] },
  { kind: 'iamleader', phrases: ['I am the leader', 'I am the team leader', 'I will lead the team'] },
  { kind: 'notleader', phrases: ['I quit being the leader', 'I do not want to be the leader', 'I stop being team leader', 'I will not be the leader'] },
];
// the task prefix EmbeddingGemma 2 takes for comparing sentences by meaning, and the dimensions kept (its
// Matryoshka truncation: the leading 128 of 768, normalized again)
export const EMBED_PREFIX = 'task: sentence similarity | query: ';
export const EMBED_DIMS = 128;
export const EMBED_MODEL = 'onnx-community/embeddinggemma-2-ONNX';
