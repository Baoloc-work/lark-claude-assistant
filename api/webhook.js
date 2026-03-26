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
  const r = await axios.get(LARK_BASE + "/bot/v3/info", { headers: { Authorization: "Bearer " + token } });
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

// Lark type codes: 2=old doc, 3=sheet, 8=bitable, 15=slide, 16=wiki, 22=docx
function detectDocType(type) {
  const t = String(type);
  if (t === "3" || t === "sheet") return "sheet";
  if (t === "8" || t === "bitable") return "bitable";
  if (t === "16" || t === "wiki") return "wiki";
  return "doc";
}

function parseMessageContent(msgType, rawContent) {
  try {
    const parsed = JSON.parse(rawContent);
    if (msgType === "text") {
      return { text: parsed.text || "", urls: extractUrls(parsed.text || "") };
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
      const token = parsed.token || parsed.doc_token || parsed.wiki_token || parsed.spreadsheet_token || "";
      const title = parsed.title || "Document";
      const typeRaw = parsed.type;
      const docType = detectDocType(typeRaw);
      console.log("[share_doc] token=" + token + " typeRaw=" + typeRaw + " docType=" + docType);
      return { text: title, urls: [], sharedToken: token, docType, rawPayload: JSON.stringify(parsed) };
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
    const r = await axios.get(LARK_BASE + "/docx/v1/documents/" + docToken + "/raw_content",
      { headers: { Authorization: "Bearer " + token } });
    if (r.data.code !== 0) throw new Error("code=" + r.data.code + ": " + r.data.msg);
    return r.data.data?.content || "";
  } catch (e) {
    if (e.response) throw new Error("DocHTTP" + e.response.status + ": " + JSON.stringify(e.response.data).substring(0, 150));
    throw e;
  }
}

// Read ALL sheets, up to maxSheets tabs, up to maxRows rows each
async function fetchSheetContent(sheetToken, maxSheets = 10, maxRows = 500) {
  const token = await getLarkToken();
  console.log("[fetchSheet] token=" + sheetToken);
  try {
    const meta = await axios.get(
      LARK_BASE + "/sheets/v3/spreadsheets/" + sheetToken + "/sheets/query",
      { headers: { Authorization: "Bearer " + token } }
    );
    if (meta.data.code !== 0) throw new Error("meta code=" + meta.data.code + ": " + meta.data.msg);
    const sheets = meta.data.data?.sheets || [];
    if (sheets.length === 0) return "(Sheet trong - khong co du lieu)";
    const parts = [];
    for (const sheet of sheets.slice(0, maxSheets)) {
      const range = sheet.sheet_id + "!A1:Z" + maxRows;
      try {
        const rv = await axios.get(
          LARK_BASE + "/sheets/v2/spreadsheets/" + sheetToken + "/values/" + range,
          { headers: { Authorization: "Bearer " + token } }
        );
        if (rv.data.code !== 0) { console.log("[fetchSheet] val code=" + rv.data.code); continue; }
        const rows = rv.data.data?.valueRange?.values || [];
        const text = rows
          .filter(row => row && row.some(c => c !== null && c !== ""))
          .map(row => (row || []).map(c => c === null ? "" : String(c)).join("\t"))
          .join("\n");
        parts.push("=== Sheet: " + sheet.title + " (" + rows.length + " hang) ===\n" + text);
      } catch (ve) {
        const vb = ve.response ? "HTTP" + ve.response.status : ve.message;
        parts.push("=== Sheet: " + sheet.title + " === (loi: " + vb + ")");
      }
    }
    if (sheets.length > maxSheets) {
      parts.push("(Con " + (sheets.length - maxSheets) + " sheet khac chua doc)");
    }
    return parts.join("\n\n") || "(Sheet trong)";
  } catch (e) {
    if (e.response) throw new Error("SheetHTTP" + e.response.status + ": " + JSON.stringify(e.response.data).substring(0, 150));
    throw e;
  }
}

// For wiki-type: try wiki API first, fallback to direct sheet/doc API with same token
async function fetchWikiOrFallback(wikiToken) {
  const token = await getLarkToken();
  console.log("[fetchWiki] token=" + wikiToken);

  // Step 1: Try wiki API to get the underlying obj_token
  try {
    const r = await axios.get(LARK_BASE + "/wiki/v2/spaces/get_node?token=" + wikiToken,
      { headers: { Authorization: "Bearer " + token } });
    if (r.data.code === 0) {
      const objToken = r.data.data?.node?.obj_token;
      const objType = r.data.data?.node?.obj_type;
      console.log("[fetchWiki] resolved obj_token=" + objToken + " obj_type=" + objType);
      if (!objToken) throw new Error("no obj_token");
      if (objType === "sheet" || objType === "bitable") return await fetchSheetContent(objToken);
      return await fetchDocContent(objToken);
    }
    console.log("[fetchWiki] wiki API code=" + r.data.code + ", trying direct fallback");
  } catch (e) {
    console.log("[fetchWiki] wiki API failed: " + e.message + ", trying direct fallback");
  }

  // Step 2: Fallback - in Lark wiki, the page token is often the same as the spreadsheet token
  // Try Sheets API directly with the wiki token
  try {
    console.log("[fetchWiki] trying sheets API directly with wiki token");
    return await fetchSheetContent(wikiToken);
  } catch (e2) {
    console.log("[fetchWiki] sheets fallback failed: " + e2.message);
  }

  // Step 3: Try Docx API directly
  try {
    console.log("[fetchWiki] trying docx API directly with wiki token");
    return await fetchDocContent(wikiToken);
  } catch (e3) {
    throw new Error("Wiki/Sheet/Doc all failed for token=" + wikiToken + ". Need wiki:wiki:readonly scope with user token access or share the doc with the bot.");
  }
}

async function getDocContent(parsed) {
  const { sharedToken, docType, rawPayload, text, urls } = parsed;
  if (sharedToken) {
    console.log("[getDocContent] token=" + sharedToken + " docType=" + docType);
    try {
      if (docType === "sheet") return await fetchSheetContent(sharedToken);
      if (docType === "bitable") return await fetchSheetContent(sharedToken);
      if (docType === "wiki") return await fetchWikiOrFallback(sharedToken);
      return await fetchDocContent(sharedToken);
    } catch (e) {
      throw new Error("READ_ERR|token=" + sharedToken + "|type=" + docType + "|err=" + e.message);
    }
  }
  const resource = extractLarkResource(text, urls);
  if (resource) {
    try {
      if (resource.type === "sheet") return await fetchSheetContent(resource.token);
      if (resource.type === "wiki") return await fetchWikiOrFallback(resource.token);
      return await fetchDocContent(resource.token);
    } catch (e) {
      throw new Error("READ_ERR|token=" + resource.token + "|type=" + resource.type + "|err=" + e.message);
    }
  }
  return null;
}

async function askClaude(userMessage, history, docContent) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  let systemPrompt = "You are a helpful business assistant in Lark for company SARA TOP SUN. Reply in Vietnamese unless the user writes in another language. Be concise and professional. When analyzing spreadsheet data, provide clear insights with numbers.";
  if (docContent) {
    // Truncate if too large (Claude context limit)
    const maxLen = 30000;
    const truncated = docContent.length > maxLen ? docContent.substring(0, maxLen) + "\n...(du lieu bi cat bo do qua dai)" : docContent;
    systemPrompt += "\n\nDu lieu bang tinh/tai lieu duoc chia se:\n\n" + truncated + "\n\nDua vao du lieu nay de tra loi chinh xac.";
  }
  const messages = [...history, { role: "user", content: userMessage }];
  const r = await axios.post(ANTHROPIC_API,
    { model: "claude-haiku-4-5-20251001", max_tokens: 1500, system: systemPrompt, messages },
    { headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" }, timeout: 30000 }
  );
  return r.data.content[0].text;
}

async function getBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (req.body && typeof req.body === "string") return JSON.parse(req.body);
  const raw = await new Promise((res, rej) => {
    let d = ""; req.on("data", c => d += c); req.on("end", () => res(d)); req.on("error", rej);
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

    if (!conversationHistory[userId]) conversationHistory[userId] = [];
    const history = conversationHistory[userId];

    try {
      const docContent = await getDocContent(parsed);
      const question = userText || "Hay tom tat va phan tich noi dung tai lieu nay.";
      const reply = await askClaude(question, history, docContent);
      history.push({ role: "user", content: question }, { role: "assistant", content: reply });
      if (history.length > MAX_HISTORY * 2) conversationHistory[userId] = history.slice(-MAX_HISTORY * 2);
      await sendText(chatId, reply);
    } catch (err) {
      if (err.message.startsWith("READ_ERR|")) {
        await sendText(chatId, "[DEBUG]\n" + err.message.replace(/\|/g, "\n")).catch(() => {});
      } else {
        const detail = err.response ? "HTTP" + err.response.status + ": " + JSON.stringify(err.response.data).substring(0, 200) : err.message;
        await sendText(chatId, "Loi: " + detail).catch(() => {});
      }
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
    if (!conversationHistory[userId]) conversationHistory[userId] = [];
    const history = conversationHistory[userId];
    try {
      const reply = await askClaude(userText, history, null);
      history.push({ role: "user", content: userText }, { role: "assistant", content: reply });
      if (history.length > MAX_HISTORY * 2) conversationHistory[userId] = history.slice(-MAX_HISTORY * 2);
      await sendText(chatId, reply);
    } catch (err) {
      const detail = err.response ? "HTTP" + err.response.status + ": " + JSON.stringify(err.response.data).substring(0, 150) : err.message;
      await sendText(chatId, "Loi: " + detail).catch(() => {});
    }
  }

  return res.status(200).json({ code: 0 });
};
