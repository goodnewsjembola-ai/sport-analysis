import { NextResponse } from "next/server";

export const revalidate = 3600;

function describeProviderError(value) {
  if (!value) return "Unknown provider error";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(describeProviderError).join("; ");
  if (typeof value === "object") {
    return Object.entries(value)
      .map(([key, detail]) => `${key}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`)
      .join("; ");
  }
  return String(value);
}

export async function GET(request) {
  const apiKey = process.env.API_FOOTBALL_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Prediction service is not configured. Check API_FOOTBALL_KEY in Vercel." },
      { status: 503 }
    );
  }

  const { searchParams } = new URL(request.url);
  const fixture = searchParams.get("fixture");

  if (!fixture || !/^\\d+$/.test(fixture)) {
    return NextResponse.json(
      { error: "A valid fixture ID is required." },
      { status: 400 }
    );
  }

  try {
    const response = await fetch(
      `https://v3.football.api-sports.io/predictions?fixture=${fixture}`,
      {
        headers: { "x-apisports-key": apiKey },
        cache: "no-store",
      }
    );

    if (response.status === 204) {
      return NextResponse.json({
        fixture: Number(fixture),
        results: 0,
        predictions: [],
        message: "API-Football has no prediction published for this fixture yet.",
      });
    }

    const data = await response.json().catch(() => ({}));
    const providerErrors = data?.errors;
    const providerDetail = describeProviderError(providerErrors);

    if (!response.ok || (providerErrors && Object.keys(providerErrors).length > 0)) {
      console.error("API-Football predictions failed:", {
        fixture,
        status: response.status,
        errors: providerErrors || data?.message || data,
      });
      return NextResponse.json(
        {
          error: "API-Football rejected the prediction request.",
          details: providerDetail,
          providerStatus: response.status,
        },
        { status: 502 }
      );
    }

    return NextResponse.json({
      fixture: Number(fixture),
      results: data.results ?? 0,
      predictions: data.response ?? [],
      message: data.results ? undefined : "API-Football has no prediction published for this fixture yet.",
    });
  } catch (error) {
    console.error("Unable to reach API-Football predictions:", error);
    return NextResponse.json(
      { error: "Unable to reach API-Football. Please try again shortly." },
      { status: 502 }
    );
  }
}
