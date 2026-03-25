const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = "claude-sonnet-4-6";

async function askClaude(userMessage, history = []) {
  const messages = [
    ...history,
    { role: "user", content: userMessage }
  ];

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: "You are a helpful business assistant integrated into Lark. Be concise, professional, and practical. Answer in the same language the user writes in.",
    messages,
  });

  return response.content[0].text;
}

async function analyzeDocument(docContent, question) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    messages: [{
      role: "user",
      content: "Document:\n" + docContent + "\n\nQuestion: " + question
    }]
  });
  return response.content[0].text;
}

async function generateScheduledReport(context) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: "You generate concise daily business reports.",
    messages: [{ role: "user", content: "Generate a daily report for: " + context }]
  });
  return response.content[0].text;
}

module.exports = { askClaude, analyzeDocument, generateScheduledReport };
