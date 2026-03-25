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
  return r.data;
}

async function askClaude(userMessage, history) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set in environment");

  const messages = [...history, { role: "user", content: userMessage }];
  const r = await axios.post(
    ANTHROPIC_API,
    {
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: "You are a helpful business assistant in Lark. Be concise and professional.",
      messages,
    },
    {
      headers: {
        "x-api-key": apiKey,
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
    return res.status(400).json({ error: "Bad request" });
  }

  if (body.type === "url_verification") {
    return res.status(200).json({ challenge: body.challenge });
  }

  res.status(200).json({ code: 0 });

  let chatId = null;
  try {
    let userId = "default";
    let userText = null;

    if (body.schema === "2.0" && body.header?.event_type === "im.message.receive_v1") {
      const evt = body.event;
      chatId = evt?.message?.chat_id;
      userId = evt?.sender?.sender_id?.open_id || "default";
      const msgType = evt?.message?.message_type;
      if (msgType !== "text") {
        await sendText(chatId, "Please send a text message.");
        return;
      }
      try { userText = JSON.parse(evt.message.content).text?.trim() || ""; }
      catch { userText = evt.message.content || ""; }
      userText = userText.replace(/@\S+/g, "").trim();
    } else if (body.event?.type === "message") {
      const evt = body.event;
      chatId = evt.open_chat_id || evt.chat_id;
      userId = evt.open_id || "default";
      userText = (evt.text_without_at_bot || evt.text || "").trim();
    }

    if (!chatId || !userText) return;

    if (!conversationHistory[userId]) conversationHistory[userId] = [];
    const history = conversationHistory[userId];

    const reply = await askClaude(userText, history);

    history.push({ role: "user", content: userText }, { role: "assistant", content: reply });
    if (history.length > MAX_HISTORY * 2) conversationHistory[userId] = history.slice(-MAX_HISTORY * 2);

    await sendText(chatId, reply);
  } catch (err) {
    // Send the actual error to Lark so we can diagnose it
    const errDetail = err.response
      ? "API error " + err.response.status + ": " + JSON.stringify(err.response.data).substring(0, 200)
      : err.message;
    console.error("Error:", errDetail);
    if (chatId) {
      try {
        await sendText(chatId, "⚠️ Error: " + errDetail);
      } catch (e2) {
        console.error("Could not send error to Lark:", e2.message);
      }
    }
  }
};
