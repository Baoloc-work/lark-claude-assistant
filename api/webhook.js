const axios = require("axios");

const LARK_BASE = "https://open.larksuite.com/open-apis";
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const conversationHistory = {};
const MAX_HISTORY = 10;

async function getLarkToken() {
  const r = await axios.post(LARK_BASE + "/auth/v3/tenant_access_token/internal", {
    app_id: process.env.LARK_APP_ID,
    app_secret: process.env.LARK_APP_SECRET,
  });
  if (r.data.code !== 0) throw new Error("Lark token error: " + r.data.msg);
  return r.data.tenant_access_token;
}

async function sendText(chatId, text) {
  const token = await getLarkToken();
  const r = await axios.post(
    LARK_BASE + "/im/v1/messages?receive_id_type=chat_id",
    { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) },
    { headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" } }
  );
  console.log("sendText:", r.data.code, r.data.msg || "");
  return r.data;
}

async function askClaude(userMessage, history) {
  const messages = [...history, { role: "user", content: userMessage }];
  const r = await axios.post(
    ANTHROPIC_API,
    {
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: "You are a helpful business assistant integrated into Lark. Be concise and professional. Reply in the same language as the user.",
      messages,
    },
    {
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      timeout: 55000,
    }
  );
  return r.data.content[0].text;
}

async function getBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (req.body && typeof req.body === "string") return JSON.parse(req.body);
  const raw = await new Promise((res, rej) => {
    let d = ""; req.on("data", c => (d += c)); req.on("end", () => res(d)); req.on("error", rej);
  });
  return JSON.parse(raw);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let body;
  try {
    body = await getBody(req);
  } catch (e) {
    console.error("Body parse error:", e.message);
    return res.status(400).json({ error: "Bad request" });
  }

  // URL verification
  if (body.type === "url_verification") {
    return res.status(200).json({ challenge: body.challenge });
  }

  // Respond to Lark immediately
  res.status(200).json({ code: 0 });

  try {
    let chatId = null;
    let userId = "default";
    let userText = null;

    // Events API v2
    if (body.schema === "2.0" && body.header?.event_type === "im.message.receive_v1") {
      const evt = body.event;
      chatId = evt?.message?.chat_id;
      userId = evt?.sender?.sender_id?.open_id || "default";
      const msgType = evt?.message?.message_type;
      console.log("v2 msg | type:", msgType, "chatId:", chatId, "userId:", userId);
      if (msgType !== "text") {
        await sendText(chatId, "Please send a text message.");
        return;
      }
      try { userText = JSON.parse(evt.message.content).text?.trim() || ""; }
      catch { userText = evt.message.content || ""; }
      userText = userText.replace(/@\S+/g, "").trim();
    }
    // Events API v1 fallback
    else if (body.event?.type === "message") {
      const evt = body.event;
      chatId = evt.open_chat_id || evt.chat_id;
      userId = evt.open_id || "default";
      userText = (evt.text_without_at_bot || evt.text || "").trim();
      console.log("v1 msg | chatId:", chatId, "userId:", userId);
    }

    if (!chatId || !userText) {
      console.log("Skipping — no chatId or text. chatId:", chatId, "text:", userText);
      return;
    }

    if (!conversationHistory[userId]) conversationHistory[userId] = [];
    const history = conversationHistory[userId];

    console.log("Asking Claude:", userText.substring(0, 80));
    const reply = await askClaude(userText, history);
    console.log("Claude replied, chars:", reply.length);

    history.push({ role: "user", content: userText }, { role: "assistant", content: reply });
    if (history.length > MAX_HISTORY * 2) conversationHistory[userId] = history.slice(-MAX_HISTORY * 2);

    await sendText(chatId, reply);
    console.log("Done.");
  } catch (err) {
    console.error("Error:", err.message);
    if (err.response) console.error("API response:", JSON.stringify(err.response.data).substring(0, 300));
  }
};
