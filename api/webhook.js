const axios = require("axios");
const LARK_BASE = "https://open.larksuite.com/open-apis";

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
  console.log("sendText result:", JSON.stringify(r.data));
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
    console.log("FULL BODY:", JSON.stringify(body).substring(0, 2000));
  } catch (e) {
    console.error("Body parse error:", e.message);
    return res.status(400).json({ error: "Bad request" });
  }

  if (body.type === "url_verification") {
    console.log("URL verification received");
    return res.status(200).json({ challenge: body.challenge });
  }

  res.status(200).json({ code: 0 });

  console.log("schema:", body.schema, "event_type:", body.header?.event_type, "v1_type:", body.event?.type);

  try {
    let chatId = null;
    let userText = null;

    if (body.schema === "2.0" && body.header?.event_type === "im.message.receive_v1") {
      const event = body.event;
      const msgType = event?.message?.message_type;
      chatId = event?.message?.chat_id;
      console.log("v2 event | msgType:", msgType, "chatId:", chatId);
      if (msgType === "text") {
        try { userText = JSON.parse(event.message.content).text?.trim() || ""; }
        catch { userText = event.message.content || ""; }
        userText = userText.replace(/@\S+/g, "").trim();
      }
    } else if (body.event?.type === "message") {
      const evt = body.event;
      chatId = evt.open_chat_id || evt.chat_id;
      userText = evt.text_without_at_bot || evt.text || "";
      console.log("v1 event | chatId:", chatId, "text:", (userText || "").substring(0, 50));
    }

    if (chatId && userText) {
      const reply = "✅ Bot is working! You said: \"" + userText + "\"\n\nThis is a diagnostic reply (no Claude yet). Connection confirmed!";
      await sendText(chatId, reply);
      console.log("Diagnostic reply sent to chatId:", chatId);
    } else {
      console.log("No chatId or userText — chatId:", chatId, "userText:", userText);
    }
  } catch (err) {
    console.error("Handler error:", err.message, err.stack ? err.stack.substring(0, 500) : "");
  }
};
