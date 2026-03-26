const axios = require("axios");

const LARK_BASE = "https://open.larksuite.com/open-apis";
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

const processedIds = new Set();
const conversationHistory = {};
const MAX_HISTORY = 10;

// Detect Lark Doc/Sheet URL patterns
function extractLarkResource(text) {
  // Lark Doc: /docx/XXXX or /docs/XXXX
  const docMatch = text.match(/(?:larksuite\.com|feishu\.cn)\/(?:docx|docs)\/([A-Za-z0-9]+)/);
  if (docMatch) return { type: 'doc', id: docMatch[1] };
  // Lark Sheet: /sheets/XXXX
  const sheetMatch = text.match(/(?:larksuite\.com|feishu\.cn)\/(?:sheets|spreadsheets)\/([A-Za-z0-9]+)/);
  if (sheetMatch) return { type: 'sheet', token: sheetMatch[1] };
  // Short doc ID pattern (standalone token)
  const tokenMatch = text.match(/\b([A-Za-z0-9]{16,}[A-Za-z0-9])\b/);
  if (tokenMatch && text.toLowerCase().includes('doc')) return { type: 'doc', id: tokenMatch[1] };
  return null;
}

async function getLarkToken() {
  const r = await axios.post(LARK_BASE + "/auth/v3/tenant_access_token/internal", {
    app_id: process.env.LARK_APP_ID,
    app_secret: process.env.LARK_APP_SECRET,
  });
  if (r.data.code !== 0) throw new Error("Lark token error: " + r.data.msg);
  return r.data.tenant_access_token;
}

async function fetchDocContent(docId) {
  const token = await getLarkToken();
  const r = await axios.get(
    LARK_BASE + "/docx/v1/documents/" + docId + "/raw_content",
    { headers: { Authorization: "Bearer " + token }, timeout: 10000 }
  );
  if (r.data.code !== 0) throw new Error("Doc error: " + r.data.msg);
  return r.data.data?.content || "";
}

async function fetchSheetContent(sheetToken) {
  const token = await getLarkToken();
  // Get sheet metadata first
  const meta = await axios.get(
    LARK_BASE + "/sheets/v3/spreadsheets/" + sheetToken,
    { headers: { Authorization: "Bearer " + token }, timeout: 10000 }
  );
  if (meta.data.code !== 0) throw new Error("Sheet meta error: " + meta.data.msg);

  const title = meta.data.data?.spreadsheet?.title || "Sheet";
  // Get first sheet data (range A1:Z100)
  const sheetId = meta.data.data?.spreadsheet?.sheets?.[0]?.sheet_id || "0";
  const values = await axios.get(
    LARK_BASE + "/sheets/v2/spreadsheets/" + sheetToken + "/values/" + sheetId + "!A1:Z100",
    { headers: { Authorization: "Bearer " + token }, timeout: 10000 }
  );
  const rows = values.data.data?.valueRange?.values || [];
  const content = rows.map(row => row.join("\t")).join("\n");
  return title + "\n" + content;
}

async function sendText(chatId, text) {
  const token = await getLarkToken();
  await axios.post(
    LARK_BASE + "/im/v1/messages?receive_id_type=chat_id",
    { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) },
    { headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" } }
  );
}

async function askClaude(userMessage, history, context) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  let system = "You are a helpful business assistant in Lark. Be concise and professional. Reply in the same language as the user.";
  if (context) {
    system += "\n\nThe user has shared a document. Here is its content:\n\n" + context.substring(0, 8000) + "\n\nAnswer their question based on this document.";
  }

  const messages = [...history, { role: "user", content: userMessage }];
  const r = await axios.post(
    ANTHROPIC_API,
    { model: "claude-haiku-4-5-20251001", max_tokens: 1024, system, messages },
    {
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      timeout: 25000,
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
  try { body = await getBody(req); }
  catch (e) { return res.status(400).json({ error: "Bad request" }); }

  if (body.type === "url_verification") return res.status(200).json({ challenge: body.challenge });

  let chatId = null;
  let userId = "default";
  let userText = null;
  let messageId = null;
  let chatType = "p2p";

  if (body.schema === "2.0" && body.header?.event_type === "im.message.receive_v1") {
    const evt = body.event;
    const msg = evt?.message;
    chatId = msg?.chat_id;
    userId = evt?.sender?.sender_id?.open_id || "default";
    messageId = msg?.message_id;
    chatType = msg?.chat_type || "p2p";

    if (msg?.message_type !== "text") {
      if (chatType === "p2p") await sendText(chatId, "Vui lòng gửi tin nhắn văn bản.");
      return res.status(200).json({ code: 0 });
    }
    if (chatType === "group" && (!msg?.mentions || msg.mentions.length === 0)) {
      return res.status(200).json({ code: 0 });
    }
    try { userText = JSON.parse(msg.content).text?.trim() || ""; }
    catch { userText = msg.content || ""; }
    userText = userText.replace(/@\S+/g, "").trim();

  } else if (body.event?.type === "message") {
    const evt = body.event;
    chatId = evt.open_chat_id || evt.chat_id;
    userId = evt.open_id || "default";
    messageId = evt.message_id;
    chatType = evt.chat_type || "p2p";
    if (chatType === "group" && !(evt.text || "").includes("<at ")) return res.status(200).json({ code: 0 });
    userText = (evt.text_without_at_bot || evt.text || "").trim();
  }

  if (!chatId || !userText) return res.status(200).json({ code: 0 });
  if (messageId && processedIds.has(messageId)) return res.status(200).json({ code: 0 });
  if (messageId) {
    processedIds.add(messageId);
    if (processedIds.size > 500) processedIds.delete(processedIds.values().next().value);
  }

  try {
    if (!conversationHistory[userId]) conversationHistory[userId] = [];
    const history = conversationHistory[userId];

    // Check if user shared a Lark Doc or Sheet link
    let docContext = null;
    const resource = extractLarkResource(userText);
    if (resource) {
      await sendText(chatId, "⏳ Đang đọc tài liệu, vui lòng chờ...");
      try {
        if (resource.type === 'doc') {
          docContext = await fetchDocContent(resource.id);
        } else if (resource.type === 'sheet') {
          docContext = await fetchSheetContent(resource.token);
        }
      } catch (fetchErr) {
        await sendText(chatId, "⚠️ Không thể đọc tài liệu: " + fetchErr.message + "\n\nHãy đảm bảo bạn đã chia sẻ tài liệu với bot hoặc cho phép toàn tổ chức xem.");
        return res.status(200).json({ code: 0 });
      }
    }

    const reply = await askClaude(userText, history, docContext);

    history.push({ role: "user", content: userText }, { role: "assistant", content: reply });
    if (history.length > MAX_HISTORY * 2) conversationHistory[userId] = history.slice(-MAX_HISTORY * 2);

    await sendText(chatId, reply);
  } catch (err) {
    const detail = err.response
      ? "API " + err.response.status + ": " + JSON.stringify(err.response.data).substring(0, 150)
      : err.message;
    try { await sendText(chatId, "\u26a0\ufe0f Lỗi: " + detail); } catch (_) {}
  }

  return res.status(200).json({ code: 0 });
};
