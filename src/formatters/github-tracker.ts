// src/formatters/github-tracker.ts
// Logic: Formatter for GitHub Tracker skill.

/**
 * @returns string - JSON stringified data
 */
export function formatGithubTracker(rawData: any): string {
    try {
        // Since handleGithubTracker already formats the data nicely,
        // we just ensure it's a valid JSON string.
        return JSON.stringify(rawData);
    } catch (error) {
        console.error("GitHub Tracker formatter failed:", error);
        return JSON.stringify({ error: "Data formatting failed", raw_sample: rawData });
    }
}
