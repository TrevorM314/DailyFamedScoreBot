import "dotenv/config";
import { getRPSChoices } from "./game.js";
import { capitalize, InstallGlobalCommands } from "./utils.js";

// https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object-interaction-context-types
const InteractionContexts = {
  GUILD: 0,
  BOT_DM: 1,
  PRIVATE_CHANNEL: 2,
};

// https://discord.com/developers/docs/resources/application#application-object-application-integration-types
const IntegrationTypes = {
  GUILD_INSTALL: 0,
  USER_INSTALL: 1,
};

// https://discord.com/developers/docs/interactions/application-commands#application-command-object-application-command-types
const CommandTypes = {
  CHAT_INPUT: 1, // Slash commands; a text-based command that shows up when a user types /
  USER: 2, // A UI-based command that shows up when you right click or tap on a user
  MESSAGE: 3, // A UI-based command that shows up when you right click or tap on a message
  PRIMARY_ENTRY_POINT: 4, // A UI-based command that represents the primary way to invoke an app's Activity
};

// Get the game choices from game.js
function createCommandChoices() {
  const choices = getRPSChoices();
  const commandChoices = [];

  for (let choice of choices) {
    commandChoices.push({
      name: capitalize(choice),
      value: choice.toLowerCase(),
    });
  }

  return commandChoices;
}

// Simple test command
const TEST_COMMAND = {
  name: "test",
  description: "Basic command",
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

const STATS_COMMAND = {
  name: "stats",
  description: "Calculates your stats based on historic frame.wtf messages",
  type: CommandTypes.CHAT_INPUT,
  integration_types: [IntegrationTypes.GUILD_INSTALL],
  contexts: [InteractionContexts.GUILD],
};

// Command containing options
const CHALLENGE_COMMAND = {
  name: "challenge",
  description: "Challenge to a match of rock paper scissors",
  options: [
    {
      type: 3,
      name: "object",
      description: "Pick your object",
      required: true,
      choices: createCommandChoices(),
    },
  ],
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 2],
};

const ALL_COMMANDS = [TEST_COMMAND, STATS_COMMAND, CHALLENGE_COMMAND];

InstallGlobalCommands(process.env.APP_ID, ALL_COMMANDS);
