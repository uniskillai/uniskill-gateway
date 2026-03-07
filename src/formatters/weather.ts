// src/formatters/weather.ts
// Logic: Specialized formatter for wttr.in (Extreme dehydration)

export function formatWeather(rawData: any): string {
    try {
        // 提取最核心的数据节点
        const area = rawData.nearest_area[0];
        const current = rawData.current_condition[0];
        const todayForecast = rawData.weather[0];

        // 重组为我们在 .md 中承诺的 Returns 结构
        const formattedData = {
            location: `${area.areaName[0].value}, ${area.country[0].value}`,
            current: {
                condition: current.weatherDesc[0].value,
                temperature: `${current.temp_C}°C`,
                humidity: `${current.humidity}%`,
                wind: `${current.windspeedKmph} km/h`
            },
            forecast: [
                {
                    date: todayForecast.date,
                    avg_temp: `${todayForecast.avgtempC}°C`,
                    condition: todayForecast.hourly[0].weatherDesc[0].value // 取中午的天气作为概览
                }
            ]
        };

        return JSON.stringify(formattedData);
    } catch (error) {
        // 逻辑：容错处理。如果第三方 API 结构变了，不要让网关崩溃，原样返回部分错误信息
        console.error("Weather formatter failed:", error);
        return JSON.stringify({ error: "Data formatting failed", raw_sample: rawData });
    }
}
