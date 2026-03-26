const axios = require("axios");

module.exports = async function handler(req, res) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(200).json({ error: "ANTHROPIC_API_KEY not set" });
  
  const keyPreview = apiKey.substring(0, 20) + "..." + apiKey.slice(-4);
  
  try {
    const r = await axios.post(
      "https://api.anthropic.com/v1/messages",
      { model: "claude-haiku-4-5-20251001", max_tokens: 50, messages: [{ role: "user", content: "Say OK" }] },
      {
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
        timeout: 15000
      }
    );
    return res.status(200).json({ 
      success: true, 
      reply: r.data.content[0].text,
      key_preview: keyPreview
    });
  } catch (err) {
    return res.status(200).json({
      success: false,
      key_preview: keyPreview,
      error: err.message,
      api_status: err.response?.status,
      api_error: err.response?.data
    });
  }
};
