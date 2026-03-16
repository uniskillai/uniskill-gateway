// scripts/test-github-tracker.ts
// Logic: Simple test script to verify the GitHub Tracker skill locally.

async function testGithubTracker() {
    const baseUrl = "http://localhost:8787/v1/execute/uniskill_github_tracker";
    const authKey = "us-test-key"; // Replace with a valid local key if needed

    const tests = [
        {
            name: "Get Trending Repos (Weekly)",
            body: { action: "get_trending_repos", time_window: "weekly" }
        },
        {
            name: "Get Language Leaders (Rust)",
            body: { action: "get_language_leaders", language: "rust" }
        },
        {
            name: "Get Repo Growth Velocity (UniSkill)",
            body: { action: "get_repo_growth_velocity", repo_path: "uniskillai/uniskill-gateway" }
        }
    ];

    for (const test of tests) {
        console.log(`\n[TEST] Running: ${test.name}`);
        try {
            const response = await fetch(baseUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${authKey}`
                },
                body: JSON.stringify(test.body)
            });

            const data: any = await response.json();
            if (response.ok) {
                console.log(`[PASS] Received ${data.data.length} results.`);
                if (data.data.length > 0) {
                    console.log(`[SAMPLE] First result: ${data.data[0].full_name} (${data.data[0].growth_velocity})`);
                }
            } else {
                console.error(`[FAIL] ${response.status}: ${data.error || JSON.stringify(data)}`);
            }
        } catch (err: any) {
            console.error(`[ERROR] ${err.message}`);
        }
    }
}

testGithubTracker();
