// src/formatters/index.ts
// 逻辑：钩子调度中心。这里的 Key 必须和 .md 文件中的 `plugin_hook` 严格一致！

import { formatWeather } from "./weather";
import { formatNews } from "./news";
import { formatSearch } from "./search";
import { formatScrape } from "./scrape";

// 定义统一的清洗器函数签名
/**
 * @returns string - All formatters must return a stringified JSON or text
 */
type FormatterFn = (data: any) => string;

export const formatters: Record<string, FormatterFn> = {
    // 逻辑：注册官方技能清洗器
    "WTTR_WEATHER_FORMATTER": formatWeather,
    "NEWS_AGGREGATOR_FORMATTER": formatNews,
    "UNISKILL_SEARCH_FORMATTER": formatSearch,
    "JINA_READER_FORMATTER": formatScrape,
};

/**
 * Logic: Plugin Manager to coordinate formatted execution
 */
export const PluginRegistryManager = {
    async format(hookName: string, rawData: any): Promise<string> {
        const formatter = formatters[hookName];

        if (formatter) {
            return formatter(rawData);
        }

        // Fallback: If no plugin registered, return raw JSON string
        return JSON.stringify(rawData);
    }
};
