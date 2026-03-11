// ============================================================
// src/utils/billing.ts
// 计费工具：负责 KV 中信用额度的查询与扣减，以及回写 Supabase
// ============================================================

import { SkillKeys } from "./skill-keys";

/**
 * Reads the current credit balance for a key hash from KV.
 * KV schema: user:credits:{hash}
 */
export async function getCredits(kv: KVNamespace, keyHash: string): Promise<number> {
    const raw = await kv.get(SkillKeys.credits(keyHash));
    if (raw === null) return -1;
    const credits = parseFloat(raw);
    return isNaN(credits) ? 0 : credits;
}

/**
 * Reads the current subscription tier for a key hash from KV.
 * KV schema: tier:{hash}
 * Default: FREE
 */
export async function getTier(kv: KVNamespace, keyHash: string): Promise<string> {
    const raw = await kv.get(SkillKeys.tier(keyHash));
    return raw || "FREE";
}

/**
 * Pushes the new credit balance back to Supabase via the Vercel Webhook.
 */
async function syncToSupabase(
    webhookUrl: string,
    adminKey: string,
    keyHash: string,
    newBalance: number,
    skillName: string,
    cost: number
): Promise<void> {
    try {
        const res = await fetch(webhookUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                // Logic: UniSkill Web expects Authorization: Bearer <ADMIN_KEY>
                "Authorization": `Bearer ${adminKey}`,
            },
            body: JSON.stringify({ hash: keyHash, newBalance, skillName, amount: -cost }),
        });
        if (!res.ok) {
            console.error(`[Sync] Webhook returned ${res.status}: ${await res.text()}`);
        } else {
            console.log(`[Sync] Supabase updated → ...${keyHash.slice(-6)} balance=${newBalance} skill=${skillName}`);
        }
    } catch (err) {
        console.error("[Sync] Failed to reach Vercel Webhook:", err);
    }
}

/**
 * Deducts `cost` credits from the key hash's balance,
 * persists it to KV, then syncs the new balance to Supabase.
 */
export async function deductCredit(
    kv: KVNamespace,
    keyHash: string,
    currentCredits: number,
    cost = 1,
    webhookUrl?: string,
    adminKey?: string,
    skillName = "unknown"
): Promise<void> {
    const newBalance = Math.round((currentCredits - cost) * 100) / 100;

    // Step 1: 写回 KV（使用标准 Key）
    await kv.put(SkillKeys.credits(keyHash), String(newBalance));

    // Step 2: 异步回写 Supabase
    if (webhookUrl && adminKey) {
        await syncToSupabase(webhookUrl, adminKey, keyHash, newBalance, skillName, cost);
    } else {
        console.warn("[Sync] VERCEL_WEBHOOK_URL or ADMIN_KEY not set. Skipping Supabase sync.");
    }
}
