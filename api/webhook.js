const axios = require("axios");

const LARK_BASE = "https://open.larksuite.com/open-apis";
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

const processedIds = new Set();
const conversationHistory = {};
const MAX_HISTORY = 10;
let BOT_OPEN_ID = null;

async function getLarkToken() {
  const r = await axios.post(LARK_BASE + "/auth/v3/tenant_access_token/internal", {
    app_id: process.env.LARK_APP_ID,
    app_secret: process.env.LARK_APP_SECRET,
  });
  if (r.data.code !== 0) throw new Error("Lark token error: " + r.data.msg);
  return r.data.tenant_access_token;
}

async function getBotOpenId() {
  if (BOT_OPEN_ID) return BOT_OPEN_ID;
  const token = await getLarkToken();
  const r = await axios.get(LARK_BASE + "/bot/v3/info", {
    headers: { Authorization: "Bearer " + token },
  });
  BOT_OPEN_ID = r.data.bot?.open_id || null;
  return BOT_OPEN_ID;
}

async function isBotMentioned(mentions) {
  if (!mentions || mentions.length === 0) return false;
  const botId = await getBotOpenId();
  if (!botId) return mentions.length > 0;
  return mentions.some((m) => m.id?.open_id === botId);
}

async function sendText(chatId, text) {
  const token = await getLarkToken();
  await axios.post(
    LARK_BASE + "/im/v1/messages?receive_id_type=chat_id",
    { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) },
    { headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" } }
  );
}

function extractUrls(text) {
  const re = /https?:\/\/[^\s<>"']+/g;
  return text.match(re) || [];
}

function parseMessageContent(msgType, rawContent) {
  try {
    const parsed = JSON.parse(rawContent);
    if (msgType === "text") {
      const text = parsed.text || "";
      return { text, urls: extractUrls(text) };
    }
    if (msgType === "post") {
      let fullText = "";
      const urls = [];
      const lang = parsed.zh_cn || parsed.en_us || parsed;
      if (lang.title) fullText += lang.title + " ";
      const content = lang.content || [];
      for (const line of content) {
        if (!Array.isArray(line)) continue;
        for (const node of line) {
          if (node.text) fullText += node.text + " ";
          if (node.href) { fullText += node.href + " "; urls.push(node.href); }
        }
      }
      return { text: fullText.trim(), urls };
    }
    if (msgType === "share_doc" || msgType === "shared_doc") {
      const token = parsed.token || parsed.doc_token || parsed.wiki_token;
      const title = parsed.title || "Document";
      const type = parsed.type || "doc";
      return { text: title, urls: [], sharedToken: token, sharedType: type };
    }
  } catch (e) {
    console.error("parseMessageContent error:", e.message);
  }
  return { text: String(rawContent), urls: [] };
}

function extractLarkResource(text, urls = []) {
  const allSources = [text, ...urls].join(" ");
  const sheetMatch = allSources.match(/(?:larksuite\.com|feishu\.cn)\/(?:sheets)\/([A-Za-z0-9_-]+)/);
  if (sheetMatch) return { type: "sheet", token: sheetMatch[1] };
  const docMatch = allSources.match(/(?:larksuite\.com|feishu\.cn)\/(?:docx|docs?)\/([A-Za-z0-9_-]+)/);
  if (docMatch) return { type: "doc", token: docMatch[1] };
  const wikiMatch = allSources.match(/(?:larksuite\.com|feishu\.cn)\/wiki\/([A-Za-z0-9_-]+)/);
  if (wikiMatch) return { type: "wiki", token: wikiMatch[1] };
  return null;
}

async function fetchDocContent(docToken) {
  const token = await getLarkToken();
  const r = await axios.get(
    LARK_BASE + "/docx/v1/documents/" + docToken + "/raw_content",
    { headers: { Authorization: "Bearer " + token } }
  );
  if (r.data.code !== 0) throw new Error("Doc error " + r.data.code + ": " + r.data.msg);
  return r.data.data?.content || "";
}

async function fetchSheetContent(sheetToken) {
  const token = await getLarkToken();
  const meta = await axios.get(
    LARK_BASE + "/sheets/v3/spreadsheets/" + sheetToken + "/sheets/query",
    { headers: { Authorization: "Bearer " + token } }
  );
  if (meta.data.code !== 0) throw new Error("Sheet meta error: " + meta.data.msg);
  const sheets = meta.data.data?.sheets || [];
  const parts = [];
  for (const sheet of sheets.slice(0, 3)) {
    const range = sheet.sheet_id + "!A1:Z200";
    const rv = await axios.get(
      LARK_BASE + "/sheets/v2/spreadsheets/" + sheetToken + "/values/" + range,
      { headers: { Authorization: "Bearer " + token } }
    );
    if (rv.data.code !== 0) continue;
    const rows = rv.data.data?.valueRange?.values || [];
    const text = rows.map((row) => (row || []).join("\t")).join("\n");
    parts.push("--- Sheet: " + sheet.title + " ---\n" + text);
  }
  return parts.join("\n\n");
}

async function fetchWikiContent(wikiToken) {
  const token = await getLarkToken();
  const r = await axios.get(
    LARK_BASE + "/wiki/v2/spaces/get_node?token=" + wikiToken,
    { headers: { Authorization: "Bearer " + token } }
  );
  if (r.data.code !== 0) throw new Error("Wiki error: " + r.data.msg);
  const objToken = r.data.data?.node?.obj_token;
  const objType = r.data.data?.node?.obj_type;
  if (!objToken) throw new Error("Wiki node has no obj_token");
  if (objType === "sheet") return fetchSheetContent(objToken);
  return fetchDocContent(objToken);
}

async function getDocContext(parsed) {
  const { text, urls, sharedToken, sharedType } = parsed;
  if (sharedToken) {
    try {
      if (sharedType === "sheet" || sharedType === "bitable") {
        const content = await fetchSheetContent(sharedToken);
        return "[Lark Sheet content]\n" + content;
      } else {
        const content = await fetchDocContent(sharedToken);
        return "[Lark Doc content]\n" + content;
      }
    } catch (e) {
      if (e.message.includes("99991663") || e.message.includes("permission")) {
        return "[Bot chua duoc cap quyen. Admin can duyet phien ban app moi trong Lark Developer Console.]";
      }
      return "[Loi doc tai lieu: " + e.message + "]";
    }
  }
  const resource = extractLarkResource(text, urls);
  if (resource) {
    try {
      if (resource.type === "sheet") {
        const content = await fetchSheetContent(resource.token);
        return "[Lark Sheet content]\n" + content;
      } else if (resource.type === "wiki") {
        const content = await fetchWikiContent(resource.token);
        return "[Lark Wiki content]\n" + content;
      } else {
        const content = await fetchDocContent(resource.token);
        return "[Lark Doc content]\n" + content;
      }
    } catch (e) {
      if (e.message.includes("99991663") || e.message.includes("permission")) {
        return "[Bot chua duoc cap quyen. Admin can duyet phien ban app moi.]";
      }
      return "[Loi doc tai lieu: " + e.message + "]";
    }
  }
  return null;
}

async function askClaude(userMessage, history, docContext) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  let systemPrompt = "You are a helpful business assistant integrated into Lark. Be concise and professional. Reply in the same language as the user.";
  if (docContext) {
    systemPrompt += "\n\nThe user has shared a document/spreadsheet. Here is its content:\n\n" + docContext + "\n\nUse this content to answer their question accurately.";
  }
  const messages = [...history, { role: "user", content: userMessage }];
  const r = await axios.post(
    ANTHROPIC_API,
    { model: "claude-haiku-4-5-20251001", max_tokens: 1024, system: systemPrompt, messages },
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
    let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => res(d)); req.on("error", rej);
  });
  return JSON.parse(raw);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  let body;
  try { body = await getBody(req); } catch (e) { return res.status(400).json({ error: "Bad request" }); }
  if (body.type === "url_verification") return res.status(200).json({ challenge: body.challenge });

  let chatId = null, userId = "default", userText = null, messageId = null, chatType = "p2p";
  let msgType = "text", rawContent = null;

  if (body.schema === "2.0" && body.header?.event_type === "im.message.receive_v1") {
    const evt = body.event;
    const msg = evt?.message;
    chatId = msg?.chat_id;
    userId = evt?.sender?.sender_id?.open_id || "default";
    messageId = msg?.message_id;
    chatType = msg?.chat_type || "p2p";
    msgType = msg?.message_type || "text";
    rawContent = msg?.content;

    if (chatType === "group") {
      const botMentioned = await isBotMentioned(msg?.mentions);
      if (!botMentioned) return res.status(200).json({ code: 0 });
    }

    if (!["text", "post", "share_doc", "shared_doc"].includes(msgType)) {
      if (chatType === "p2p") await sendText(chatId, "Vui long gui tin nhan van ban hoac chia se tai lieu Lark.");
      return res.status(200).json({ code: 0 });
    }

    const parsed = parseMessageContent(msgType, rawContent);
    userText = parsed.text.replace(/@\S+/g, "").trim();
    if (!userText && !parsed.sharedToken) return res.status(200).json({ code: 0 });

    if (messageId && processedIds.has(messageId)) return res.status(200).json({ code: 0 });
    if (messageId) { processedIds.add(messageId); if (processedIds.size > 500) processedIds.delete(processedIds.values().next().value); }

    try {
      if (!conversationHistory[userId]) conversationHistory[userId] = [];
      const history = conversationHistory[userId];
      const docContext = await getDocContext(parsed);
      const question = userText || "Hay tom tat noi dung tai lieu nay.";
      const reply = await askClaude(question, history, docContext);
      history.push({ role: "user", content: question }, { role: "assistant", content: reply });
      if (history.length > MAX_HISTORY * 2) conversationHistory[userId] = history.slice(-MAX_HISTORY * 2);
      await sendText(chatId, reply);
    } catch (err) {
      const detail = err.response ? "API " + err.response.status + ": " + JSON.stringify(err.response.data).substring(0, 150) : err.message;
      try { await sendText(chatId, "Loi: " + detail); } catch (_) {}
    }

  } else if (body.event?.type === "message") {
    const evt = body.event;
    chatId = evt.open_chat_id || evt.chat_id;
    userId = evt.open_id || "default";
    messageId = evt.message_id;
    chatType = evt.chat_type || "p2p";
    if (chatType === "group" && !(evt.text || "").includes("<at ")) return res.status(200).json({ code: 0 });
    userText = (evt.text_without_at_bot || evt.text || "").trim();
    if (!chatId || !userText) return res.status(200).json({ code: 0 });
    if (messageId && processedIds.has(messageId)) return res.status(200).json({ code: 0 });
    if (messageId) { processedIds.add(messageId); if (processedIds.size > 500) processedIds.delete(processedIds.values().next().value); }
    try {
      if (!conversationHistory[userId]) conversationHistory[userId] = [];
      const history = conversationHistory[userId];
      const reply = await askClaude(userText, history, null);
      history.push({ role: "user", content: userText }, { role: "assistant", content: reply });
      if (history.length > MAX_HISTORY * 2) conversationHistory[userId] = history.slice(-MAX_HISTORY * 2);
      await sendText(chatId, reply);
    } catch (err) {
      const detail = err.response ? "API " + err.response.status + ": " + JSON.stringify(err.response.data).substring(0, 150) : err.message;
      try { await sendText(chatId, "Loi: " + detail); } catch (_) {}
    }
  }

  return res.status(200).json({ code: 0 });
};
