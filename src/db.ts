import { createClient } from '@supabase/supabase-js';

/**
 * Initialize Supabase client using environment variables
 */
const getSupabaseClient = (env: any) => {
    return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
};

/**
 * Fetch the user's data (tier and credits) from the 'profiles' table
 * Returns default values if the record is missing.
 */
export const fetchUserDataFromDB = async (
    keyHash: string,
    env: any
): Promise<{ tier: string; credits: number }> => {
    const supabase = getSupabaseClient(env);

    // 查询 profiles 表，使用已哈希的 key (key_hash) 匹配
    const { data, error } = await supabase
        .from("profiles")
        .select("tier, credits")
        .eq("key_hash", keyHash)
        .single();

    if (error) {
        console.error("[DB Fallback] Supabase query error:", error.message);
        return { tier: "FREE", credits: 0 };
    }

    return {
        tier: data?.tier?.toUpperCase() || "FREE",
        credits: typeof data?.credits === "number" ? data.credits : 0,
    };
};
