// src/formatters/scrape.ts
// Logic: Formatter for webpage scraping (Jina)

export function formatScrape(data: any): string {
    const content = data.content || data.markdown || "Failed to extract content.";
    const url = data.url || "Unknown Source";

    // 逻辑：对于抓取，我们保留其原生的 Markdown 输出，但限制长度
    let truncatedContent = content;
    if (truncatedContent.length > 10000) {
        truncatedContent = truncatedContent.substring(0, 10000) + "... [Content Truncated]";
    }

    return `### Scraped Content from: ${url}\n---\n${truncatedContent}\n---`;
}
