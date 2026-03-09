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

        const data: any = await response.json();

        // 4. 提取核心气象数据，精简返回体，防止撑爆大模型上下文
        const currentWeather = data.current_condition?.[0] || {};
        const weatherDesc = currentWeather.lang_zh?.[0]?.value || currentWeather.weatherDesc?.[0]?.value || "Unknown";

        const finalResult = {
            location: location,
            temperature_c: currentWeather.temp_C,
            condition: weatherDesc,
            humidity: currentWeather.humidity,
            wind_kph: currentWeather.windspeedKmph,
            observation_time: currentWeather.observation_time
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
