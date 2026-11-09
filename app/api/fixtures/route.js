function getLagosDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export async function GET(request) {
  const apiKey = process.env.API_FOOTBALL_KEY;

  if (!apiKey) {
    return Response.json(
      {
        error: "Football data is not configured yet.",
        code: "MISSING_API_KEY",
      },
      { status: 503 }
    );
  }

  const requestedDate = new URL(request.url).searchParams.get("date");
  const date = requestedDate || getLagosDate();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json(
      { error: "Date must use YYYY-MM-DD format.", code: "INVALID_DATE" },
      { status: 400 }
    );
  }

  const apiUrl = new URL("https://v3.football.api-sports.io/fixtures");
  apiUrl.searchParams.set("date", date);
  apiUrl.searchParams.set("timezone", "Africa/Lagos");

  try {
    const response = await fetch(apiUrl, {
      method: "GET",
      headers: {
        "x-apisports-key": apiKey,
      },
      next: { revalidate: 600 },
    });

    const data = await response.json();

    if (!response.ok || (data.errors && Object.keys(data.errors).length > 0)) {
      console.error("API-Football fixtures request failed:", {
        status: response.status,
        errors: data.errors,
      });

      return Response.json(
        {
          error: "The football data provider could not return fixtures right now.",
          code: "PROVIDER_ERROR",
        },
        { status: 502 }
      );
    }

    return Response.json({
      date,
      timezone: "Africa/Lagos",
      results: data.results ?? 0,
      fixtures: data.response ?? [],
    });
  } catch (error) {
    console.error("Fixtures request failed:", error);

    return Response.json(
      {
        error: "Unable to reach the football data provider. Please try again later.",
        code: "UPSTREAM_UNAVAILABLE",
      },
      { status: 502 }
    );
  }
}
