/**
 * Lark Webhook Handler
 *
 * This is the main entry point for all Lark events.
 * It handles:
 *   1. URL verification (one-time challenge when setting up webhook)
 *   2. Incoming messages → Claude AI response
 *   3. File/document uploads → Claude document analysis
 */

const crypto = require("crypto");
const { replyToMessage, sendCardMessage, buildResponseCard } = require("../lib/lark");
const { askClaude, analyzeDocument, classifyIntent } = require("../lib/claude");

// In-memory conversation store (per user, resets on cold start)
// For production, replace with Redis or a database
const conversationHistory = {};
const MAX_HISTORY = 10; // Keep last 10 messages per user

/**
 * Verify that the request is genuinely from Lark
 */
function verifyLarkSignature(req, body) {
  const encryptKey = process.env.LARK_ENCRYPT_KEY;
  if (!encryptKey) return true; // Skip verification if no key set

  const timestamp = req.headers["x-lark-request-timestamp"];
  const nonce = req.headers["x-lark-request-nonce"];
  const signature = req.headers["x-lark-signature"];

  if (!timestamp || !nonce || !signature) return false;

  const toVerify = timestamp + nonce + encryptKey + body;
  const computed = crypto.createHash("sha256").update(toVerify).digest("hex");
  return computed === signature;
}

/**
 * Parse raw body from Vercel request
 */
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/**
 * Process a text message from a user
 */
async function handleTextMessage(event) {
  const userId = event.sender?.sender_id?.open_id || "unknown";
  const messageId = event.message?.message_id;
  const chatId = event.message?.chat_id;
  const rawContent = event.message?.content;

  let userText = "";
  try {
    const content = JSON.parse(rawContent);
    userText = content.text?.trim() || "";
  } catch {
    userText = rawContent || "";
  }

  // Remove @bot mention if present
  userText = userText.replace(/@\S+/g, "").trim();

  if (!userText) return;

  // Maintain conversation history per user
  if (!conversationHistory[userId]) {
    conversationHistory[userId] = [];
  }
  const history = conversationHistory[userId];

  try {
    // Get Claude's response
    const aiResponse = await askClaude(userText, history);

    // Update history
    history.push(
      { role: "user", content: userText },
      { role: "assistant", content: aiResponse }
    );

    // Trim history to last MAX_HISTORY messages
    if (history.length > MAX_HISTORY * 2) {
      conversationHistory[userId] = history.slice(-MAX_HISTORY * 2);
    }

    // Build a card for rich formatting
    const card = buildResponseCard("🤖 Claude Assistant", aiResponse);
    await sendCardMessage(chatId, card);
  } catch (error) {
    console.error("Error processing message:", error);
    await replyToMessage(
      messageId,
      "⚠️ Sorry, I encountered an error. Please try again."
    );
  }
}

/**
 * Process a file/document message
 */
async function handleFileMessage(event) {
  const chatId = event.message?.chat_id;
  const messageId = event.message?.message_id;

  try {
    // Notify user we're processing
    await replyToMessage(messageId, "📄 I received your file. Analyzing it now...");

    // For now, ask user to paste text content
    // (Full file parsing requires additional setup - see README)
    const card = buildResponseCard(
      "📄 Document Analysis",
      `To analyze your document, please paste the text content directly in the chat and say:\n\n**"Analyze this: [paste your text here]"**\n\nFor full PDF/Word support, follow the advanced setup in the README.`
    );
    await sendCardMessage(chatId, card);
  } catch (error) {
    console.error("Error handling file:", error);
  }
}

/**
 * Main handler — Vercel serverless function
 */
module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const rawBody = await getRawBody(req);

  // Verify signature
  if (!verifyLarkSignature(req, rawBody)) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  // ─── 1. URL Verification Challenge ───────────────────────────────────────
  // Lark sends this once when you first set up your webhook URL
  if (body.type === "url_verification") {
    return res.status(200).json({ challenge: body.challenge });
  }

  // ─── 2. Event Callback ───────────────────────────────────────────────────
  if (body.schema === "2.0") {
    // Lark Events API v2
    const event = body.event;
    const eventType = body.header?.event_type;

    // Acknowledge immediately to avoid timeout (Lark expects response within 3s)
    res.status(200).json({ code: 0 });

    // Process asynchronously
    if (eventType === "im.message.receive_v1") {
      const msgType = event?.message?.message_type;

      if (msgType === "text") {
        await handleTextMessage(event);
      } else if (msgType === "file" || msgType === "image") {
        await handleFileMessage(event);
      }
    }
  } else {
    // Lark Events API v1 (older format)
    res.status(200).json({ code: 0 });

    if (body.event?.type === "message") {
      await handleTextMessage({ message: body.event, sender: body.event });
    }
  }
};

// Required for Vercel to read the raw body
module.exports.config = {
  api: {
    bodyParser: false,
  },
};
