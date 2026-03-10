import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const GATEWAY_ROOT = path.resolve(__dirname, '..');
const DOCS_DIR = path.join(GATEWAY_ROOT, 'docs');
const SRC_DIR = path.join(GATEWAY_ROOT, 'src');

/**
 * Extracts TIER_CONFIG from src/rateLimit.ts
 */
function extractTierConfig(): Record<string, number> {
    const filePath = path.join(SRC_DIR, 'rateLimit.ts');
    const content = fs.readFileSync(filePath, 'utf-8');
    const match = content.match(/export const TIER_CONFIG: Record<string, number> = ({[\s\S]+?});/);
    if (!match) throw new Error('Could not find TIER_CONFIG in rateLimit.ts');

    // Evaluation-lite: parse the object string
    const objStr = match[1].replace(/\/\/.*$/gm, ''); // remove comments
    const config: Record<string, number> = {};
    const entryRegex = /(\w+):\s*(\d+)/g;
    let entry;
    while ((entry = entryRegex.exec(objStr)) !== null) {
        config[entry[1]] = parseInt(entry[2], 10);
    }
    return config;
}

/**
 * Extracts skill costs from src/index.ts
 */
function extractSkillCosts(): Record<string, number> {
    const filePath = path.join(SRC_DIR, 'index.ts');
    const content = fs.readFileSync(filePath, 'utf-8');
    const costs: Record<string, number> = {};

    // Default cost
    const defaultMatch = content.match(/let skillCost = (\d+);/);
    if (defaultMatch) costs['default'] = parseInt(defaultMatch[1], 10);

    // Specific costs in the if/else block
    const costBlockRegex = /if \(skillName === "([^"]+)" \|\| skillName === "([^"]+)"(?: \|\| skillName === "([^"]+)")?\) \{\s+skillCost = (\d+);/g;
    let match;
    while ((match = costBlockRegex.exec(content)) !== null) {
        const cost = parseInt(match[match.length - 1], 10);
        for (let i = 1; i < match.length - 1; i++) {
            if (match[i]) costs[match[i]] = cost;
        }
    }
    return costs;
}

/**
 * Updates a file by replacing content between markers
 */
function updateFileWithMarkers(filePath: string, marker: string, newContent: string) {
    const fullPath = path.join(DOCS_DIR, filePath);
    if (!fs.existsSync(fullPath)) return;

    let content = fs.readFileSync(fullPath, 'utf-8');
    const startMarker = `{/* AUTO_GEN:${marker}_START */}`;
    const endMarker = `{/* AUTO_GEN:${marker}_END */}`;

    const startIndex = content.indexOf(startMarker);
    const endIndex = content.indexOf(endMarker);

    if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
        content = content.substring(0, startIndex) +
            startMarker + '\n\n' + newContent + '\n\n' +
            content.substring(endIndex);
        fs.writeFileSync(fullPath, content);
        console.log(`Updated ${filePath} [${marker}]`);
    } else {
        console.warn(`Marker ${marker} not found in ${filePath}`);
    }
}

async function main() {
    console.log('🚀 Starting Documentation Sync...');

    try {
        const tiers = extractTierConfig();
        const costs = extractSkillCosts();

        // 1. Update rate-limits.mdx
        const tierTable = [
            '| Tier | Rate Limit (RPM) | Features |',
            '| :--- | :--- | :--- |',
            `| **Free** | ${tiers.FREE} RPM | Entry level access |`,
            `| **Starter** | ${tiers.STARTER} RPM | Basic API access |`,
            `| **Pro** | ${tiers.PRO} RPM | Priority support, audit logs |`,
            `| **Scale** | ${tiers.SCALE} RPM | Multi-key management, dedicated bandwidth |`
        ].join('\n');
        updateFileWithMarkers('rate-limits.mdx', 'TIER_TABLE', tierTable);

        // 2. Update credits.mdx Tiers
        const creditTierTable = [
            '| Tier | Price | Monthly Credits Included | Rate Limit (RPM) | Log Retention |',
            '| :--- | :--- | :--- | :--- | :--- |',
            `| **Free** | $0 | 500 | ${tiers.FREE} | 3 Days |`,
            `| **Starter** | $9.90 | 10,000 | ${tiers.STARTER} | 7 Days |`,
            `| **Pro** | $29.90 | 35,000 | ${tiers.PRO} | 30 Days |`,
            `| **Scale** | $99.90 | 150,000 | ${tiers.SCALE} | 90 Days |`
        ].join('\n');
        updateFileWithMarkers('credits.mdx', 'TIER_TABLE', creditTierTable);

        // 3. Update credits.mdx Costs
        const costTable = [
            '| Skill | Description | Cost |',
            '| :--- | :--- | :--- |',
            `| \`uniskill_search\` | Real-time global web search | ${costs.uniskill_search || 10} pts / call |`,
            `| \`uniskill_scrape\` | Full-page Markdown extraction | ${costs.uniskill_scrape || 20} pts / page |`,
            `| \`basic-connector\` | Generic API Proxy | ${costs.default || 1} pts / call |`
        ].join('\n');
        updateFileWithMarkers('credits.mdx', 'COST_TABLE', costTable);

        console.log('✅ Documentation Sync Complete!');
    } catch (error) {
        console.error('❌ Sync Failed:', error);
        process.exit(1);
    }
}

main();
