// uniskill-gateway/src/routes/weather.ts
// Logic: Weather fetcher using the open wttr.in API (No API Key required)

import type { Env } from "../index";
import { errorResponse } from "../utils/response";

export async function handleWeather(request: Request, _env: Env): Promise<Response> {
    // 1. 极其严谨的跨域头部
    const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders });
    }

    // 2. 兼容 GET 和 POST 两种传参方式
    let location = "London"; // 默认兜底

    try {
        if (request.method === "POST") {
            const body: any = await request.json();
            if (body.location || body.query) {
                location = body.location || body.query;
            }
        } else if (request.method === "GET") {
            const url = new URL(request.url);
            const queryLoc = url.searchParams.get("location") || url.searchParams.get("query");
            if (queryLoc) location = queryLoc;
        }

        console.log(`[Weather] Fetching data for: ${location}`);

        // 3. 调用极客专属开源 API (wttr.in)，加上 format=j1 获取纯净 JSON
        const targetUrl = `https://wttr.in/${encodeURIComponent(location)}?format=j1`;

        const response = await fetch(targetUrl, {
            headers: { "Accept-Language": "zh-CN,en;q=0.9" } // 支持中文返回
        });

        if (!response.ok) {
            throw new Error(`Upstream API returned ${response.status}`);
        }

        const rawText = await response.text();
        let data: any;
        try {
            data = JSON.parse(rawText);
        } catch (e: any) {
            // Logic: Robust parsing for pretty-printed or slightly malformed upstream JSON
            throw new Error(`Failed to parse weather JSON: ${e.message}`);
        }

        // 4. 提取核心气象数据，精简返回体，符合 formatters 结构
        const current = data.current_condition?.[0] || {};
        const area = data.nearest_area?.[0] || {};
        const todayForecast = data.weather?.[0] || {};

        const weatherDesc = current.lang_zh?.[0]?.value || current.weatherDesc?.[0]?.value || "Unknown";

        const finalResult = {
            location: `${area.areaName?.[0]?.value || location}, ${area.country?.[0]?.value || ""}`,
            current: {
                condition: weatherDesc,
                temperature: `${current.temp_C}°C`,
                humidity: `${current.humidity}%`,
                wind: `${current.windspeedKmph} km/h`
            },
            forecast: [
                {
                    date: todayForecast.date,
                    avg_temp: `${todayForecast.avgtempC}°C`,
                    condition: todayForecast.hourly?.[0]?.weatherDesc?.[0]?.value || "Clear"
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
