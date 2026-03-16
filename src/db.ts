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
): Promise<{ user_uid: string, tier: string; credits: number }> => {
    const supabase = getSupabaseClient(env);

    // 查询 profiles 表
    const { data, error } = await supabase
        .from("profiles")
        .select("user_uid, tier, credits") 
        .eq("key_hash", keyHash)
        .single();

    if (error) {
        console.error("[DB Fallback] Supabase query error:", error.message);
        return { user_uid: "anonymous", tier: "FREE", credits: 0 };
    }

    return {
        user_uid: data?.user_uid || "anonymous",
        tier: data?.tier?.toUpperCase() || "FREE",
        credits: typeof data?.credits === "number" ? data.credits : 0,
    };
};

/**
 * Fetch the user's data (tier and credits) from the 'profiles' table using UID.
 */
export const fetchUserDataByUid = async (
    uid: string,
    env: any
): Promise<{ user_uid: string, tier: string; credits: number }> => {
    const supabase = getSupabaseClient(env);

    const { data, error } = await supabase
        .from("profiles")
        .select("user_uid, tier, credits") 
        .eq("user_uid", uid)
        .single();

    if (error) {
        console.error("[DB Fallback] Supabase query error by UID:", error.message);
        return { user_uid: uid, tier: "FREE", credits: 0 };
    }

    return {
        user_uid: data?.user_uid || uid,
        tier: data?.tier?.toUpperCase() || "FREE",
        credits: typeof data?.credits === "number" ? data.credits : 0,
    };
};
