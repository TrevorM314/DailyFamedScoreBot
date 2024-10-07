import "dotenv/config";
import express from "express";
import {
  InteractionType,
  InteractionResponseType,
  verifyKeyMiddleware,
} from "discord-interactions";
import { getRandomEmoji, DiscordRequest } from "./utils.js";
import { setTimeout } from "timers/promises";
import serverless from "serverless-http";
import bodyParser from "body-parser";

const jsonParser = bodyParser.json();

/**
 * https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object
 * @typedef {Object} InteractionPayload
 * @property {string} token
 * @property {string} id - Interaction Id
 * @property {Object} data - Data about the interaction
 * @property {String} data.id
 * @property {String} data.name
 * @property {number} data.type
 * @property {number} type
 * @property {string} channel_id
 * @property {string} application_id
 *
 * @typedef {Object} Stats
 * @property {number} daysPlayed
 * @property {number} score
 *
 * @typedef {Object.<string, Stats>} UserStatsMap
 *
 * @typedef {Object} FramedResults
 * @property {number} failedAttempts
 *
 * @typedef {Object.<number, FramedResults>} UserHistory
 * A collection of days mapped to the user's score for that day
 *
 * @typedef {Object.<string, UserHistory} UserHistories
 * The key is the userId
 */

/**
 * @typedef {Object} Message
 * @property {string} id
 * @property {string} content
 * @property {Object} author
 * @property {string} author.id
 * @property {string} author.username
 * @property {string} author.global_name // User's nickname within the server
 * @property {Object} interaction
 * @property {string} interaction.id
 * @property {string} interaction.token
 * 
 * sample message
 * {
    type: 20,
    content: 'hello world 👋',
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    timestamp: '2024-09-27T00:45:34.417000+00:00',
    edited_timestamp: null,
    flags: 0,
    components: [],
    id: '1289025106915622934',
    channel_id: '1289022276636774404',
    author: {
      id: '1286835367974277120',
      username: 'Framed Stats Bot',
      avatar: null,
      discriminator: '8724',
      public_flags: 524288,
      flags: 524288,
      bot: true,
      banner: null,
      accent_color: null,
      global_name: null,
      avatar_decoration_data: null,
      banner_color: null,
      clan: null
    },
    pinned: false,
    mention_everyone: false,
    tts: false,
    application_id: '1286835367974277120',
    interaction: {
      id: '1289025105820909682',
      type: 2,
      name: 'test',
      user: [Object]
    },
    webhook_id: '1286835367974277120',
    position: 0,
    interaction_metadata: {
      id: '1289025105820909682',
      type: 2,
      user: [Object],
      authorizing_integration_owners: [Object],
      name: 'test',
      command_type: 1
    }
  },
 */

// Create an express app
const app = express();
// Get port, or default to 3000
const PORT = process.env.PORT || 3000;
const LOCAL = process.env.LOCAL && process.env.LOCAL.toLowerCase() === "true";
const SERVER_URL = LOCAL ? "http://localhost:3000" : process.env.SERVER_URL;

const FRAMED_MESSAGE_START = "Framed #";

/**
 * Interactions endpoint URL where Discord will send HTTP requests
 * Parse request body and verifies incoming requests using discord-interactions package
 */
app.post(
  "/interactions",
  verifyKeyMiddleware(process.env.PUBLIC_KEY),
  async function (req, res) {
    console.log("Handling interaction");
    /** @type {InteractionPayload} */
    const payload = req.body;
    // Interaction type and data
    const { channel, type, data } = payload;
    console.log(`Interaction type: ${type}`);

    /**
     * Handle verification requests
     */
    if (type === InteractionType.PING) {
      return res.send({ type: InteractionResponseType.PONG });
    }

    if (type === InteractionType.MESSAGE_COMPONENT) {
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: "I saw your message",
        },
      });
    }

    /**
     * Handle slash command requests
     * See https://discord.com/developers/docs/interactions/application-commands#slash-commands
     */
    if (type === InteractionType.APPLICATION_COMMAND) {
      const { name } = data;

      // "test" command
      if (name === "test") {
        // Send a message into the channel where command was triggered from
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            // Fetches a random emoji to send from a helper function
            content: `hello world ${getRandomEmoji()}`,
          },
        });
      }

      if (name === "stats") {
        return handleStatsCommand(req, res);
      }

      console.error(`unknown command: ${name}`);
      return res.status(400).json({ error: "unknown command" });
    }

    console.error("unknown interaction type", type);
    return res.status(400).json({ error: "unknown interaction type" });
  }
);

app.post("/process-stats-interaction", jsonParser, async function (req, res) {
  console.log("Handling /process-stats-interaction request");
  /** @type {UserHistories} */
  let allUserHistories = {}; // The key is the userId
  const userIdsToName = {};
  /** @type {InteractionPayload} */
  const payload = req.body;
  const { channel } = payload;

  let earliestDiscoveredMessage = channel.last_message_id;
  /** @type { Array<Message> } */
  let messages;
  do {
    const messagesResponse = await DiscordRequest(
      `/channels/${channel.id}/messages?before=${earliestDiscoveredMessage}&limit=100`,
      {}
    );
    messages = await messagesResponse.json();
    if (messages.length === 0) break;
    for (const message of messages) {
      if (message.content.startsWith(FRAMED_MESSAGE_START)) {
        console.log("Framed message detected");
        allUserHistories = updateUserHistories(allUserHistories, message);
        userIdsToName[message.author.id] = [message.author.global_name];
      }
    }
    earliestDiscoveredMessage = messages[messages.length - 1].id;

    const rateLimitRemaining = parseInt(
      messagesResponse.headers.get("x-ratelimit-remaining")
    );
    const rateLimitResetAfter = parseFloat(
      messagesResponse.headers.get("x-ratelimit-reset-after")
    );
    if (rateLimitRemaining <= 0) {
      const timeout = rateLimitResetAfter * 1000;
      console.log(`Rate limit reached. Sleeping for ${timeout} ms`);
      await setTimeout(timeout);
    }
  } while (messages.length > 0);

  const stats = constructStats(allUserHistories);

  const responseMessageContent = constructStatsMessage(stats, userIdsToName);

  console.log("Sending patch request to discord");
  const callbackEndpoint = `webhooks/${payload.application_id}/${payload.token}/messages/@original`;
  const response = await DiscordRequest(callbackEndpoint, {
    method: "PATCH",
    body: {
      content: responseMessageContent,
    },
  });

  res.send({
    success: true,
  });
});

app.post("/test", jsonParser, async function (req, res) {
  console.log("Handling test");
  console.log(req.body);
});

app.get("/ping", async function (req, res) {
  return res.send({
    message: "pong",
  });
});

async function handleStatsCommand(req, res) {
  // do NOT await. This sends to lambda for async processing without needing a stream.
  const processingUrl = `${SERVER_URL}/process-stats-interaction`;
  console.log(`Sending process request to lambda at ${processingUrl}`);
  const responsePromise = fetch(processingUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(req.body),
  });
  const timeoutPromise = setTimeout(1000, "TIMEOUT");

  const result = await Promise.race([responsePromise, timeoutPromise]);
  if (result == "TIMEOUT") {
    console.log("Request timed out. Continuing to process async");
  } else {
    console.log("Response received");
  }

  console.log("Responding with deferred message");
  return res.send({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  });
}

/**
 * @param {UserHistories} userHistories
 * @param {Message} message
 * @returns {UserHistories} updatedUserHistories
 */
function updateUserHistories(userHistories, message) {
  let updatedUserHistories = Object.assign({}, userHistories);

  const regex = new RegExp(`^${FRAMED_MESSAGE_START}(\\d+)`);
  const regexMatches = regex.exec(message.content);
  const day = parseInt(regexMatches[1]);

  const failedAttempts = (message.content.match(/🟥/g) || []).length;
  // console.log(`Failed Attempts: ${failedAttempts}`);

  // const succeeded = message.content.includes("🟩");
  // console.log(`Succeeded: ${succeeded}`);

  if (!updatedUserHistories[message.author.id]) {
    updatedUserHistories[message.author.id] = {};
  }

  updatedUserHistories[message.author.id][day] = {
    failedAttempts,
  };

  return updatedUserHistories;
}

/**
 *
 * @param {UserHistories} userHistories
 * @returns {UserStatsMap}
 */
function constructStats(userHistories) {
  /** @type {UserStatsMap} */
  let allUserStats = {};
  const userIds = Object.keys(userHistories);
  for (const userId of userIds) {
    const userHistory = userHistories[userId];
    const userStats = emptyStats();
    for (const day of Object.keys(userHistory)) {
      userStats.daysPlayed++;
      userStats.score += 6 - userHistory[day].failedAttempts;
    }
    allUserStats[userId] = userStats;
  }
  return allUserStats;
}

/**
 *
 * @param {UserStatsMap} stats
 * @param {Object.<string, string>} userIdsToNames
 * @returns {string}
 */
function constructStatsMessage(stats, userIdsToNames) {
  let responseContent = "Scores:\n";
  for (const userId of Object.keys(stats)) {
    const username = userIdsToNames[userId];
    responseContent +=
      `\n${username}: \n` +
      `    score: ${stats[userId].score}\n` +
      `    days played: ${stats[userId].daysPlayed}\n`;
  }
  return responseContent;
}

/**
 *
 * @returns {Stats}
 */
function emptyStats() {
  return {
    daysPlayed: 0,
    score: 0,
  };
}

// if (LOCAL) {
//   app.listen(PORT, () => {
//     console.log("Listening on port", PORT);
//   });
// }

export default serverless(app);
