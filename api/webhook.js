const crypto = require("crypto");
const axios = require("axios");
const { askClaude } = require("../lib/claude");

const LARK_BASE = "https://open.larksuite.com/open-apis";
const conversationHistory = {};
const MAX_HISTORY = 10;

async function getToken() {
  const r = await axios.post(LARK_BASE + "/auth/v3/tenant_access_token/internal", {
    app_id: process.env.LARK_APP_ID,
    app_secret: process.env.LARK_APP_SECRET,
  });
  if (r.data.code !== 0) throw new Error("Token error: " + r.data.msg);
  return r.data.tenant_access_token;
}

async function sendText(chatId, text) {
  const token = await getToken();
  const r = await axios.post(
    LARK_BASE + "/im/v1/messages?receive_id_type=chat_id",
    { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) },
    { headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" } }
  );
  console.log("sendText result:", r.data.code, r.data.msg);
  return r.data;
}

async function getBody(req) {
  if (req.body && typeof req.body === "object") return { body: req.body, raw: JSON.stringify(req.body) };
  if (req.body && typeof req.body === "string") return { body: JSON.parse(req.body), raw: req.body };
  const raw = await new Promise((res, rej) => {
    let d = ""; req.on("data", c => (d += c)); req.on("end", () => res(d)); req.on("error", rej);
  });
  if (!raw) throw new Error("Empty body");
  return { body: JSON.parse(raw), raw };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let body;
  try {
    const parsed = await getBody(req);
    body = parsed.body;
    console.log("Received event type:", body.type || body.header?.event_type || "unknown");
  } catch (e) {
    console.error("Body parse error:", e.message);
    return res.status(400).json({ error: "Bad request" });
  }

  // URL verification
  if (body.type === "url_verification") {
    return res.status(200).json({ challenge: body.challenge });
  }

  // Acknowledge immediately
  res.status(200).json({ code: 0 });

  try {
    if (body.schema === "2.0" && body.header?.event_type === "im.message.receive_v1") {
      const event = body.event;
      const msgType = event?.message?.message_type;
      const chatId = event?.message?.chat_id;
      const userId = event?.sender?.sender_id?.open_id || "unknown";
      const rawContent = event?.message?.content;

      console.log("Message type:", msgType, "chatId:", chatId, "userId:", userId);

      if (msgType !== "text") {
        await sendText(chatId, "Please send a text message. I can help with business questions, drafting emails, and document analysis!");
        return;
      }

      let userText = "";
      try { userText = JSON.parse(rawContent).text?.trim() || ""; }
      catch { userText = rawContent || ""; }
      userText = userText.replace(/@\S+/g, "").trim();

      if (!userText) return;

      if (!conversationHistory[userId]) conversationHistory[userId] = [];
      const history = conversationHistory[userId];

      console.log("Calling Claude for:", userText.substring(0, 80));
      const aiReply = await askClaude(userText, history);
      console.log("Claude replied, length:", aiReply.length);

      history.push({ role: "user", content: userText }, { role: "assistant", content: aiReply });
      if (history.length > MAX_HISTORY * 2) conversationHistory[userId] = history.slice(-MAX_HISTORY * 2);

      await sendText(chatId, aiReply);
      console.log("Message sent successfully");
    }
  } catch (err) {
    console.error("Handler error:", err.message, err.stack?.substring(0, 300));
  }
};
