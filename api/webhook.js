/**
 * Lark Webhook Handler
 */

const crypto = require("crypto");
const { replyToMessage, sendCardMessage, buildResponseCard } = require("../lib/lark");
const { askClaude, analyzeDocument, classifyIntent } = require("../lib/claude");

const conversationHistory = {};
const MAX_HISTORY = 10;

function verifyLarkSignature(req, rawBody) {
  const encryptKey = process.env.LARK_ENCRYPT_KEY;
  if (!encryptKey) return true;
  const timestamp = req.headers["x-lark-request-timestamp"];
  const nonce = req.headers["x-lark-request-nonce"];
  const signature = req.headers["x-lark-signature"];
  if (!timestamp || !nonce || !signature) return false;
  const toVerify = timestamp + nonce + encryptKey + rawBody;
  const computed = crypto.createHash("sha256").update(toVerify).digest("hex");
  return computed === signature;
}

async function getBody(req) {
  // Case 1: Vercel already parsed the JSON body (default behavior)
  if (req.body && typeof req.body === "object") {
    return { body: req.body, rawBody: JSON.stringify(req.body) };
  }
  // Case 2: Body is a string
  if (req.body && typeof req.body === "string") {
    return { body: JSON.parse(req.body), rawBody: req.body };
  }
  // Case 3: Read raw from stream
  const rawBody = await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
  if (!rawBody) throw new Error("Empty request body");
  return { body: JSON.parse(rawBody), rawBody };
}

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
  userText = userText.replace(/@\S+/g, "").trim();
  if (!userText) return;

  console.log("Processing message from " + userId + ": " + userText.substring(0, 100));

  if (!conversationHistory[userId]) conversationHistory[userId] = [];
  const history = conversationHistory[userId];

  try {
    const aiResponse = await askClaude(userText, history);
    history.push({ role: "user", content: userText }, { role: "assistant", content: aiResponse });
    if (history.length > MAX_HISTORY * 2) conversationHistory[userId] = history.slice(-MAX_HISTORY * 2);
    const card = buildResponseCard("Claude Assistant", aiResponse);
    await sendCardMessage(chatId, card);
    console.log("Sent response to " + chatId);
  } catch (error) {
    console.error("Error:", error.message);
    await replyToMessage(messageId, "Sorry, I encountered an error. Please try again.");
  }
}

async function handleFileMessage(event) {
  const chatId = event.message?.chat_id;
  const messageId = event.message?.message_id;
  try {
    await replyToMessage(messageId, "I received your file. To analyze it, paste the text and say: Analyze this: [your text]");
    const card = buildResponseCard("Document Analysis", "Paste your document text and prefix with: Analyze this:");
    await sendCardMessage(chatId, card);
  } catch (error) {
    console.error("File error:", error.message);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let body, rawBody;
  try {
    const parsed = await getBody(req);
    body = parsed.body;
    rawBody = parsed.rawBody;
  } catch (err) {
    console.error("Body parse error:", err.message);
    return res.status(400).json({ error: "Invalid request body" });
  }

  if (!verifyLarkSignature(req, rawBody)) return res.status(401).json({ error: "Invalid signature" });

  if (body.type === "url_verification") {
    console.log("URL verification");
    return res.status(200).json({ challenge: body.challenge });
  }

  if (body.schema === "2.0") {
    const event = body.event;
    const eventType = body.header?.event_type;
    console.log("Event: " + eventType);
    res.status(200).json({ code: 0 });
    if (eventType === "im.message.receive_v1") {
      const msgType = event?.message?.message_type;
      if (msgType === "text") await handleTextMessage(event);
      else if (msgType === "file" || msgType === "image") await handleFileMessage(event);
    }
  } else {
    res.status(200).json({ code: 0 });
    if (body.event?.type === "message") await handleTextMessage({ message: body.event, sender: body.event });
  }
};
