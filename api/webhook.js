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
  if (req.body && typeof req.body === "object") return { body: req.body };
  if (req.body && typeof req.body === "string") return { body: JSON.parse(req.body) };
  const raw = await new Promise((res, rej) => {
    let d = ""; req.on("data", c => (d += c)); req.on("end", () => res(d)); req.on("error", rej);
  });
  if (!raw) throw new Error("Empty body");
  return { body: JSON.parse(raw) };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let body;
  try {
    const parsed = await getBody(req);
    body = parsed.body;
    console.log("Event type:", body.header?.event_type || body.type || body.event?.type || "unknown");
  } catch (e) {
    console.error("Body parse error:", e.message);
    return res.status(400).json({ error: "Bad request" });
  }

  if (body.type === "url_verification") {
    return res.status(200).json({ challenge: body.challenge });
  }

  // Respond to Lark immediately (within 3s requirement)
  res.status(200).json({ code: 0 });

  try {
    let chatId = null;
    let userId = "unknown";
    let userText = null;

    // Lark Events API v2
    if (body.schema === "2.0" && body.header?.event_type === "im.message.receive_v1") {
      const event = body.event;
      const msgType = event?.message?.message_type;
      chatId = event?.message?.chat_id;
      userId = event?.sender?.sender_id?.open_id || "unknown";

      if (msgType !== "text") {
        await sendText(chatId, "Please send a text message.");
        return;
      }

      try { userText = JSON.parse(event.message.content).text?.trim() || ""; }
      catch { userText = event.message.content || ""; }
      userText = userText.replace(/@\S+/g, "").trim();
    }
    // Lark Events API v1 fallback
    else if (body.event?.type === "message") {
      const evt = body.event;
      chatId = evt.open_chat_id || evt.chat_id;
      userId = evt.open_id || evt.user_open_id || "unknown";
      userText = (evt.text_without_at_bot || evt.text || "").trim();
    }

    if (!chatId || !userText) {
      console.log("No chatId or userText, skipping. chatId:", chatId, "text:", userText);
      return;
    }

    // Maintain conversation history per user
    if (!conversationHistory[userId]) conversationHistory[userId] = [];
    const history = conversationHistory[userId];

    console.log("Calling Claude for user", userId, "text:", userText.substring(0, 80));
    const aiReply = await askClaude(userText, history);
    console.log("Claude replied, length:", aiReply.length);

    history.push({ role: "user", content: userText }, { role: "assistant", content: aiReply });
    if (history.length > MAX_HISTORY * 2) {
      conversationHistory[userId] = history.slice(-MAX_HISTORY * 2);
    }

    await sendText(chatId, aiReply);
    console.log("Reply sent successfully");
  } catch (err) {
    console.error("Handler error:", err.message, err.stack ? err.stack.substring(0, 400) : "");
    // Try to send an error message back to user
    try {
      const body2 = body;
      const chatId2 = body2?.event?.message?.chat_id || body2?.event?.open_chat_id;
      if (chatId2) {
        const token = await getToken();
        await axios.post(
          LARK_BASE + "/im/v1/messages?receive_id_type=chat_id",
          { receive_id: chatId2, msg_type: "text", content: JSON.stringify({ text: "Sorry, I encountered an error. Please try again." }) },
          { headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" } }
        );
      }
    } catch (e2) { console.error("Error sending error message:", e2.message); }
  }
};
