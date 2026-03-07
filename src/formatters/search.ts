// src/formatters/search.ts
// Logic: Specialized formatter for uniskill_search (Tavily)

export function formatSearch(data: any): string {
    // 逻辑：提取 Tavily 生成的综合答案（Agent 可直接引用）
    const answer = data.answer ?? null;
    const rawResults = data.results ?? [];

    // 逻辑：将结果规范化为 Agent易于处理的格式，并进行强截断以节省模型 Token
    const cleanedResults = rawResults.slice(0, 5).map((r: any) => {
        const title = r.title ?? "";
        const url = r.url ?? "";
        const score = r.score ?? 0;

        // 逻辑：单条内容硬截断至 1500 字符，防止撑爆上下文上限
        let content = r.content ?? "";
        if (content.length > 1500) {
            content = content.substring(0, 1500) + "...";
        }

        return {
            title,
            url,
            content,
            relevance_score: score,
        };
    });

    return JSON.stringify({
        answer: answer,
        results: cleanedResults,
        total_results: cleanedResults.length
    });
}
