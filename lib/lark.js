/**
 * Lark API helper functions
 * Handles authentication and messaging with Lark (Feishu)
 */

const axios = require("axios");

const LARK_BASE_URL = "https://open.larksuite.com/open-apis";
// If you're using Feishu (China), change to: https://open.feishu.cn/open-apis

let cachedToken = null;
let tokenExpiry = 0;

/**
 * Get a valid tenant access token (auto-refreshes when expired)
 */
async function getTenantAccessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiry) {
    return cachedToken;
  }

  const response = await axios.post(
    `${LARK_BASE_URL}/auth/v3/tenant_access_token/internal`,
    {
      app_id: process.env.LARK_APP_ID,
      app_secret: process.env.LARK_APP_SECRET,
    }
  );

  if (response.data.code !== 0) {
    throw new Error(`Failed to get Lark token: ${response.data.msg}`);
  }

  cachedToken = response.data.tenant_access_token;
  // Token is valid for 2 hours, refresh 5 minutes early
  tokenExpiry = now + (response.data.expire - 300) * 1000;
  return cachedToken;
}

/**
 * Send a text message to a Lark chat
 * @param {string} receiveId - The chat_id or open_id to send to
 * @param {string} text - The message content
 * @param {string} receiveIdType - "chat_id" | "open_id" | "user_id"
 */
async function sendTextMessage(receiveId, text, receiveIdType = "chat_id") {
  const token = await getTenantAccessToken();

  const response = await axios.post(
    `${LARK_BASE_URL}/im/v1/messages?receive_id_type=${receiveIdType}`,
    {
      receive_id: receiveId,
      msg_type: "text",
      content: JSON.stringify({ text }),
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    }
  );

  if (response.data.code !== 0) {
    throw new Error(`Failed to send message: ${response.data.msg}`);
  }

  return response.data;
}

/**
 * Send a rich card (interactive) message to Lark
 * Used for formatted reports and structured responses
 */
async function sendCardMessage(receiveId, card, receiveIdType = "chat_id") {
  const token = await getTenantAccessToken();

  const response = await axios.post(
    `${LARK_BASE_URL}/im/v1/messages?receive_id_type=${receiveIdType}`,
    {
      receive_id: receiveId,
      msg_type: "interactive",
      content: JSON.stringify(card),
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    }
  );

  if (response.data.code !== 0) {
    throw new Error(`Failed to send card: ${response.data.msg}`);
  }

  return response.data;
}

/**
 * Reply to a specific message in a thread
 */
async function replyToMessage(messageId, text) {
  const token = await getTenantAccessToken();

  const response = await axios.post(
    `${LARK_BASE_URL}/im/v1/messages/${messageId}/reply`,
    {
      msg_type: "text",
      content: JSON.stringify({ text }),
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    }
  );

  if (response.data.code !== 0) {
    throw new Error(`Failed to reply: ${response.data.msg}`);
  }

  return response.data;
}

/**
 * Download a file from Lark (for document analysis)
 */
async function downloadFile(messageId, fileKey, fileType) {
  const token = await getTenantAccessToken();

  const response = await axios.get(
    `${LARK_BASE_URL}/im/v1/messages/${messageId}/resources/${fileKey}?type=${fileType}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      responseType: "arraybuffer",
    }
  );

  return response.data;
}

/**
 * Build a beautiful card for AI responses
 */
function buildResponseCard(title, content, footer = "Powered by Claude AI") {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: title },
      template: "blue",
    },
    elements: [
      {
        tag: "div",
        text: { tag: "lark_md", content: content },
      },
      { tag: "hr" },
      {
        tag: "note",
        elements: [{ tag: "plain_text", content: footer }],
      },
    ],
  };
}

module.exports = {
  getTenantAccessToken,
  sendTextMessage,
  sendCardMessage,
  replyToMessage,
  downloadFile,
  buildResponseCard,
};
