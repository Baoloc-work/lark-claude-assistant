/**
 * Scheduled Report Handler
 *
 * This runs automatically every weekday at 9:00 AM (configured in vercel.json).
 * It sends an AI-generated morning briefing to your designated Lark group chat.
 *
 * Schedule can be customized in vercel.json:
 *   "0 9 * * 1-5"  = 9:00 AM, Monday–Friday (UTC)
 *   "0 1 * * 1-5"  = 8:00 AM Vietnam time (UTC+7) on weekdays
 */

const { sendCardMessage, buildResponseCard } = require("../lib/lark");
const { generateScheduledReport } = require("../lib/claude");

module.exports = async function handler(req, res) {
  // Security: Only allow Vercel's cron caller
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const reportGroupChatId = process.env.LARK_REPORT_CHAT_ID;
  if (!reportGroupChatId) {
    return res
      .status(400)
      .json({ error: "LARK_REPORT_CHAT_ID not configured" });
  }

  try {
    // Generate the report using Claude
    const reportContent = await generateScheduledReport("daily manager briefing", {
      date: new Date().toISOString(),
    });

    // Send to Lark group chat
    const today = new Date().toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });

    const card = buildResponseCard(
      `📊 Manager Briefing — ${today}`,
      reportContent,
      "Sent automatically by Claude AI Assistant"
    );

    await sendCardMessage(reportGroupChatId, card);

    return res.status(200).json({ success: true, message: "Report sent!" });
  } catch (error) {
    console.error("Scheduled report error:", error);
    return res.status(500).json({ error: error.message });
  }
};
