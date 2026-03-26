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

function isSheetType(type) {
  return type === 3 || type === "3" || type === "sheet" || type === 8 || type === "8" || type === "bitable";
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
      // Echo raw payload for debug
      const rawStr = JSON.stringify(parsed);
      console.log("[share_doc raw]", rawStr);
      const token = parsed.token || parsed.doc_token || parsed.wiki_token || parsed.spreadsheet_token;
      const title = parsed.title || "Document";
      const type = parsed.type;
      return { text: title, urls: [], sharedToken: token, sharedTypeRaw: type, debugRaw: rawStr };
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
  try {
    const r = await axios.get(
      LARK_BASE + "/docx/v1/documents/" + docToken + "/raw_content",
      { headers: { Authorization: "Bearer " + token } }
    );
    if (r.data.code !== 0) throw new Error("Doc code=" + r.data.code + " msg=" + r.data.msg);
    return r.data.data?.content || "";
  } catch (e) {
    if (e.response) throw new Error("Doc HTTP " + e.response.status + ": " + JSON.stringify(e.response.data).substring(0, 150));
    throw e;
  }
}

async function fetchSheetContent(sheetToken) {
  const token = await getLarkToken();
  console.log("[fetchSheet] sheetToken=" + sheetToken);
  try {
    const meta = await axios.get(
      LARK_BASE + "/sheets/v3/spreadsheets/" + sheetToken + "/sheets/query",
      { headers: { Authorization: "Bearer " + token } }
    );
    if (meta.data.code !== 0) throw new Error("Sheet meta code=" + meta.data.code + " msg=" + meta.data.msg);
    const sheets = meta.data.data?.sheets || [];
    const parts = [];
    for (const sheet of sheets.slice(0, 3)) {
      const range = sheet.sheet_id + "!A1:Z100";
      try {
        const rv = await axios.get(
          LARK_BASE + "/sheets/v2/spreadsheets/" + sheetToken + "/values/" + encodeURIComponent(range),
          { headers: { Authorization: "Bearer " + token } }
        );
        if (rv.data.code !== 0) { console.log("[fetchSheet] values code=" + rv.data.code); continue; }
        const rows = rv.data.data?.valueRange?.values || [];
        const text = rows.map((row) => (row || []).join("\t")).join("\n");
        parts.push("--- Sheet: " + sheet.title + " ---\n" + text);
      } catch (ve) {
        console.error("[fetchSheet] values error:", ve.response ? ve.response.status + " " + JSON.stringify(ve.response.data).substring(0,100) : ve.message);
      }
    }
    return parts.join("\n\n") || "(Sheet trong nhung du lieu)";
  } catch (e) {
    if (e.response) throw new Error("Sheet HTTP " + e.response.status + ": " + JSON.stringify(e.response.data).substring(0, 200));
    throw e;
  }
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
  const { text, urls, sharedToken, sharedTypeRaw, debugRaw } = parsed;
  if (sharedToken) {
    const useSheet = isSheetType(sharedTypeRaw);
    console.log("[getDocContext] token=" + sharedToken + " typeRaw=" + sharedTypeRaw + " useSheet=" + useSheet);
    try {
      if (useSheet) {
        const content = await fetchSheetContent(sharedToken);
        return "[Lark Sheet]\n" + content;
      } else {
        const content = await fetchDocContent(sharedToken);
        return "[Lark Doc]\n" + content;
      }
    } catch (e) {
      console.error("[getDocContext] error:", e.message);
      // Return debug info so Claude can tell user what happened
      return "[DEBUG] token=" + sharedToken + " typeRaw=" + sharedTypeRaw + " error=" + e.message;
    }
  }
  const resource = extractLarkResource(text, urls);
  if (resource) {
    try {
      if (resource.type === "sheet") return "[Lark Sheet]\n" + await fetchSheetContent(resource.token);
      if (resource.type === "wiki") return "[Lark Wiki]\n" + await fetchWikiContent(resource.token);
      return "[Lark Doc]\n" + await fetchDocContent(resource.token);
    } catch (e) {
      console.error("[getDocContext] URL error:", e.message);
      return "[DEBUG URL] token=" + resource.token + " type=" + resource.type + " error=" + e.message;
    }
  }
  return null;
}

async function askClaude(userMessage, history, docContext) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  let systemPrompt = "You are a helpful business assistant integrated into Lark. Reply in the same language as the user (Vietnamese if they write Vietnamese). Be concise and professional.";
  if (docContext) {
    if (docContext.startsWith("[DEBUG]")) {
      systemPrompt += "\n\nCo loi xay ra khi doc tai lieu. Thong tin debug: " + docContext + ". Hay bao loi nay cho user biet bang tieng Viet, hien thi day du thong tin debug.";
    } else {
      systemPrompt += "\n\nNoi dung tai lieu:\n\n" + docContext + "\n\nDung thong tin nay de tra loi cau hoi.";
    }
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

    console.log("[webhook] msgType=" + msgType + " chatType=" + chatType + " messageId=" + messageId);

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
      console.error("[webhook] fatal:", err.message);
      const detail = err.response ? "HTTP " + err.response.status + ": " + JSON.stringify(err.response.data).substring(0, 150) : err.message;
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
      console.error("[webhook] v1 error:", err.message);
      const detail = err.response ? "HTTP " + err.response.status + ": " + JSON.stringify(err.response.data).substring(0, 150) : err.message;
      try { await sendText(chatId, "Loi: " + detail); } catch (_) {}
    }
  }

  return res.status(200).json({ code: 0 });
};
