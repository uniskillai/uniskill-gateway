// uniskill-gateway/src/routes/github-tracker.ts
// Logic: Intelligence tool for tracking GitHub repository trends and growth.

import type { Env } from "../index";
import { errorResponse } from "../utils/response";

interface GithubRepo {
    name: string;
    full_name: string;
    description: string;
    html_url: string;
    stargazers_count: number;
    forks_count: number;
    language: string;
    created_at: string;
    owner: {
        login: string;
        type: string;
    };
    topics: string[];
}

export async function handleGithubTracker(request: Request, env: Env): Promise<Response> {
    const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders });
    }

    try {
        let body: any = {};
        if (request.method === "POST") {
            body = await request.json();
        }

        const action = body.action || "get_trending_repos";
        const timeWindow = body.time_window || "weekly";
        const language = body.language;
        const topic = body.topic;
        const repoPath = body.repo_path;
        const minStars = body.min_stars;
        const maxStars = body.max_stars;

        const headers: Record<string, string> = {
            "Accept": "application/vnd.github.v3+json",
            "User-Agent": "UniSkill-Gateway"
        };

        if (env.GITHUB_TOKEN) {
            headers["Authorization"] = `token ${env.GITHUB_TOKEN}`;
        }

        if (action === "get_trending_repos" || action === "get_language_leaders") {
            let query = "";
            let starFilter = "";

            if (minStars !== undefined && maxStars !== undefined) {
                starFilter = `stars:${minStars}..${maxStars}`;
            } else if (minStars !== undefined) {
                starFilter = `stars:>=${minStars}`;
            } else if (maxStars !== undefined) {
                starFilter = `stars:<= ${maxStars}`;
            }
            
            if (action === "get_trending_repos") {
                const now = new Date();
                let days = 7;
                if (timeWindow === "daily") days = 1;
                if (timeWindow === "monthly") days = 30;
                
                const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
                query = `created:>${since}`;
                if (starFilter) query += ` ${starFilter}`;
            } else {
                query = starFilter || "stars:>100"; // Fallback for leaders
            }

            if (language) query += ` language:${language}`;
            if (topic) query += ` topic:${topic}`;

            const searchUrl = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=10`;
            const response = await fetch(searchUrl, { headers });
            
            if (!response.ok) {
                const err = await response.text();
                throw new Error(`GitHub API error: ${response.status} ${err}`);
            }

            const data: any = await response.json();
            const results = data.items.map((repo: GithubRepo) => processRepoData(repo, timeWindow));

            return new Response(JSON.stringify({ status: "success", data: results }), {
                status: 200,
                headers: { "Content-Type": "application/json", ...corsHeaders }
            });

        } else if (action === "get_repo_growth_velocity") {
            if (!repoPath) return errorResponse("Missing repo_path for growth velocity calculation", 400);

            const repoUrl = `https://api.github.com/repos/${repoPath}`;
            const response = await fetch(repoUrl, { headers });

            if (!response.ok) {
                if (response.status === 404) return errorResponse(`Repository [${repoPath}] not found`, 404);
                const err = await response.text();
                throw new Error(`GitHub API error: ${response.status} ${err}`);
            }

            const repo: GithubRepo = await response.json();
            const result = processRepoData(repo, timeWindow);

            return new Response(JSON.stringify({ status: "success", data: [result] }), {
                status: 200,
                headers: { "Content-Type": "application/json", ...corsHeaders }
            });

        } else {
            return errorResponse(`Unsupported action: ${action}`, 400);
        }

    } catch (error: any) {
        console.error("[GitHub Tracker] Error:", error.message);
        return errorResponse(`Failed to track GitHub data: ${error.message}`, 500);
    }
}

function processRepoData(repo: GithubRepo, window: string) {
    const createdDate = new Date(repo.created_at);
    const now = new Date();
    const ageInDays = Math.max(1, Math.floor((now.getTime() - createdDate.getTime()) / (24 * 60 * 60 * 1000)));
    
    // Logic: Calculate growth velocity (simple proxy: stars/age)
    const velocityPerDay = repo.stargazers_count / ageInDays;
    let velocityStr = "";
    
    if (window === "daily") {
        velocityStr = `+${velocityPerDay.toFixed(1)} stars/day`;
    } else if (window === "monthly") {
        velocityStr = `+${(velocityPerDay * 30).toFixed(0)} stars/month`;
    } else {
        velocityStr = `+${(velocityPerDay * 7).toFixed(0)} stars/week`;
    }

    // Rich Metadata: Owner Type Identification
    const ownerType = repo.owner.type === "Organization" ? "Organization / Big Tech" : "Personal (Indie Hacker)";

    return {
        name: repo.name,
        full_name: repo.full_name,
        description: repo.description,
        url: repo.html_url,
        stars: repo.stargazers_count,
        forks: repo.forks_count,
        language: repo.language,
        growth_velocity: velocityStr,
        owner_type: ownerType,
        domain_topics: repo.topics.slice(0, 5) // Limit to top 5 topics
    };
}
