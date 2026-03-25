module.exports = function handler(req, res) {
  res.status(200).json({
    status: "ok", service: "Lark Claude Assistant", timestamp: new Date().toISOString(),
    env: {
      lark_app_id: process.env.LARK_APP_ID ? "✅ Set" : "❌ Missing",
      anthropic_key: process.env.ANTHROPIC_API_KEY ? "✅ Set" : "❌ Missing",
      report_chat_id: process.env.LARK_REPORT_CHAT_ID ? "✅ Set" : "⚠️ Optional"
    }
  });
};