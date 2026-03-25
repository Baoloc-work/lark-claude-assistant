/**
 * Claude AI helper functions
 * Handles all interactions with the Anthropic API
 */

const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// System prompt tailored for business manager assistant
const SYSTEM_PROMPT = `You are an intelligent AI assistant built for business managers. You help with:

1. **Q&A**: Answer questions about business strategy, operations, KPIs, and management best practices.
2. **Task Automation**: Help draft emails, reports, meeting summaries, and action plans.
3. **Document Analysis**: Analyze uploaded documents and extract key insights, risks, or action items.
4. **Decision Support**: Provide data-driven insights and structured recommendations.

Guidelines:
- Be concise and action-oriented. Managers are busy.
- Use bullet points and structure for clarity.
- Always end with a clear "Next Steps" or "Recommendation" section when relevant.
- If analyzing a document, lead with the most critical finding.
- Respond in the same language the user writes in.`;

async function askClaude(userMessage, conversationHistory = []) {
  const messages = [
    ...conversationHistory,
    { role: "user", content: userMessage },
  ];
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages,
  });
  return response.content[0].text;
}

async function analyzeDocument(documentText, userInstruction = "summarize") {
  const prompt = `The user has shared a document and wants you to: **${userInstruction}**

Here is the document content:
---
${documentText.substring(0, 15000)} ${documentText.length > 15000 ? "\n[Document truncated for length...]" : ""}
---

Please provide a structured analysis based on the request.`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 3000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }],
  });
  return response.content[0].text;
}

async function generateScheduledReport(reportType = "daily standup", data = {}) {
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
  const prompt = `Generate a professional ${reportType} report for ${today}.

${Object.keys(data).length > 0 ? `Context data: ${JSON.stringify(data, null, 2)}` : ""}

Structure the report with:
1. **Date & Overview**
2. **Key Focus Areas Today**
3. **Reminders & Deadlines**
4. **Manager Tips** (one actionable tip for business managers)

Keep it concise and motivating.`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }],
  });
  return response.content[0].text;
}

async function classifyIntent(userMessage) {
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 20,
    messages: [{
      role: "user",
      content: `Classify this message into one word: "qa", "task", "document", or "unknown".\nMessage: "${userMessage}"\nReply with only the classification word.`,
    }],
  });
  return response.content[0].text.trim().toLowerCase();
}

module.exports = { askClaude, analyzeDocument, generateScheduledReport, classifyIntent };
