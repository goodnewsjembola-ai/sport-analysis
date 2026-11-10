import { NextResponse } from "next/server";

export const revalidate = 3600;

export async function GET(request) {
  const apiKey = process.env.API_FOOTBALL_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Prediction service is not configured yet." },
      { status: 503 }
    );
  }

  const { searchParams } = new URL(request.url);
  const fixture = searchParams.get("fixture");

  if (!fixture || !/^\d+$/.test(fixture)) {
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
        next: { revalidate: 3600 },
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return NextResponse.json(
        { error: "The prediction provider could not complete the request." },
        { status: response.status }
      );
    }

    if (data.errors && Object.keys(data.errors).length > 0) {
      return NextResponse.json(
        { error: "The prediction provider returned an error.", details: data.errors },
        { status: 502 }
      );
    }

    return NextResponse.json({
      fixture: Number(fixture),
      results: data.results ?? 0,
      predictions: data.response ?? [],
    });
  } catch {
    return NextResponse.json(
      { error: "Unable to reach the prediction service. Please try again." },
      { status: 502 }
    );
  }
}
