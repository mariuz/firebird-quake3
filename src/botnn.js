// botnn.js – the bots' fight moves as a network learned them (scripts/rl-deep.mjs: Double DQN with a conservative
// penalty, trained on the moves logged in self-play): rows of [layer, unit, input (-1 the bias), weight] for
// the bot_nn table (sql/schema.sql; bot_nn_best in sql/bots.sql)
export const BOT_NN = [];
