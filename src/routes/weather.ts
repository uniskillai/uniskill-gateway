// uniskill-gateway/src/routes/weather.ts
// Logic: Weather fetcher using Open-Meteo API (no API key, globally reliable)

import type { Env } from "../index";
import { errorResponse } from "../utils/response";

const WMO_CODE_MAP: Record<number, string> = {
    0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Fog", 48: "Icy fog", 51: "Light drizzle", 53: "Moderate drizzle",
    55: "Dense drizzle", 61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
    71: "Slight snow", 73: "Moderate snow", 75: "Heavy snow",
    80: "Slight showers", 81: "Moderate showers", 82: "Violent showers",
    95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Thunderstorm with heavy hail",
};

export async function handleWeather(request: Request, _env: Env): Promise<Response> {
    const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders });
    }

    let location = "London";

    try {
        if (request.method === "POST") {
            const body: any = await request.json();
            location = body.location || body.query || location;
        } else if (request.method === "GET") {
            const url = new URL(request.url);
            location = url.searchParams.get("location") || url.searchParams.get("query") || location;
        }

        console.log(`[Weather] Fetching data for: ${location}`);

        // Step 1: Geocoding — 城市名 → 经纬度 (Open-Meteo Geocoding API)
        const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`;
        const geoRes = await fetch(geoUrl);
        if (!geoRes.ok) throw new Error(`Geocoding API returned ${geoRes.status}`);

        const geoData: any = await geoRes.json();
        if (!geoData.results || geoData.results.length === 0) {
            return new Response(JSON.stringify({ status: "error", error: `Location not found: ${location}` }), {
                status: 404,
                headers: { "Content-Type": "application/json", ...corsHeaders }
            });
        }

        const { latitude, longitude, name, country } = geoData.results[0];

        // Step 2: Weather — 经纬度 → 实时气象 (Open-Meteo Weather API)
        const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=auto&forecast_days=1`;
        const weatherRes = await fetch(weatherUrl);
        if (!weatherRes.ok) throw new Error(`Weather API returned ${weatherRes.status}`);

        const weatherData: any = await weatherRes.json();
        const cur = weatherData.current;
        const daily = weatherData.daily;

        const finalResult = {
            location: `${name}, ${country}`,
            current: {
                condition: WMO_CODE_MAP[cur.weather_code] || `WMO ${cur.weather_code}`,
                temperature: `${cur.temperature_2m}°C`,
                humidity: `${cur.relative_humidity_2m}%`,
                wind: `${cur.wind_speed_10m} km/h`
            },
            forecast: [
                {
                    date: daily.time?.[0],
                    max_temp: `${daily.temperature_2m_max?.[0]}°C`,
                    min_temp: `${daily.temperature_2m_min?.[0]}°C`,
                    condition: WMO_CODE_MAP[daily.weather_code?.[0]] || "Unknown"
                }
            ]
        };

        return new Response(JSON.stringify({ status: "success", data: finalResult }), {
            status: 200,
            headers: { "Content-Type": "application/json", ...corsHeaders }
        });

    } catch (error: any) {
        console.error("[Weather] Error:", error.message);
        return errorResponse(`Failed to fetch weather: ${error.message}`, 500);
    }
}
