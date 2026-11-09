export async function GET() {
  return Response.json({
    status: "ok",
    application: "G SPORT ANALYSIS",
    footballDataConfigured: Boolean(process.env.API_FOOTBALL_KEY),
    message: process.env.API_FOOTBALL_KEY
      ? "Football data key is configured on the server."
      : "Football data key has not been added yet."
  });
}
