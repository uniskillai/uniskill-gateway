// src/formatters/news.ts
// Logic: Formatter for news aggregation

export function formatNews(data: any): string {
    const articles = data.articles || [];
    if (articles.length === 0) return "No recent news found.";

    const cleanedArticles = articles.slice(0, 8).map((article: any) => ({
        title: article.title,
        url: article.url,
        publishedAt: article.publishedAt,
        description: article.description?.substring(0, 200)
    }));

    return JSON.stringify({
        status: "success",
        articles: cleanedArticles
    });
}
