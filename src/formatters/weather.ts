// src/formatters/weather.ts
// Logic: Specialized formatter for wttr.in (Extreme dehydration)

/**
 * @returns string - JSON stringified weather data
 */
export function formatWeather(rawData: any): string {
    try {
        // 提取数据节点（增加可选链防护）
        const area = rawData?.nearest_area?.[0];
        const current = rawData?.current_condition?.[0];
        
        if (!area || !current) {
            return JSON.stringify({ error: "Upstream weather data is incomplete", raw: rawData });
        }

        // 重组为我们在 .md 中承诺的 Returns 结构
        const formattedData = {
            location: `${area.areaName?.[0]?.value || 'Unknown'}, ${area.country?.[0]?.value || 'Unknown'}`,
            current: {
                condition: current.weatherDesc?.[0]?.value || 'N/A',
                temperature: `${current.temp_C || '?'}°C`,
                humidity: `${current.humidity || '?'}%`,
                wind: `${current.windspeedKmph || '?'} km/h`
            },
            forecast: (rawData.weather || []).map((day: any) => ({
                date: day.date,
                avg_temp: `${day.avgtempC}°C`,
                condition: day.hourly?.[4]?.weatherDesc?.[0]?.value || day.hourly?.[0]?.weatherDesc?.[0]?.value || 'N/A'
            }))
        };

        return JSON.stringify(formattedData);
    } catch (error) {
        // 逻辑：容错处理。如果第三方 API 结构变了，不要让网关崩溃
        console.error("Weather formatter failed:", error);
        return JSON.stringify({ error: "Data formatting failed", raw_sample: rawData });
    }
}
