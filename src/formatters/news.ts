// src/formatters/news.ts
// Logic: Formatter for news aggregation

/**
 * @returns string - JSON stringified results
 */
export function formatNews(data: any): string {
    // Tavily Search API returns data in `results`
    const articles = data.results || data.articles || [];

    if (articles.length === 0) {
        return "No recent news found.";
    }

    const cleanedArticles = articles.slice(0, 8).map((article: any) => ({
        title: article.title,
        url: article.url,
        publishedAt: article.published_date || article.publishedAt,
        description: (article.content || article.description || "").substring(0, 300)
    }));

    return JSON.stringify({
        status: "success",
        articles: cleanedArticles
    });
}
