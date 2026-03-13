import { createClient } from '@supabase/supabase-js';

/**
 * Initialize Supabase client
 */
const getSupabaseClient = (env: any) => {
    return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
};

/**
 * Records skill usage in Supabase using the integrated 'skills' table.
 * Supports dual-dimension statistics (credits/usdc).
 */
export async function recordSkillCall(
    env: any, 
    userUid: string,
    skillName: string, 
    requestId: string,
    cost: number = 0, 
    paymentType: 'credits' | 'usdc' = 'credits', 
    status: string = 'success',
    cost_per_call?: number,
    display_name?: string, // Added for initial sync
    tags?: string[]       // Added for initial sync
): Promise<void> {
    const supabase = getSupabaseClient(env);

    try {
        const { error } = await supabase.rpc('record_skill_usage', {
            p_user_uid: userUid,
            p_skill_name: skillName,
            p_payment_type: paymentType,
            p_request_id: requestId,
            p_cost: cost,
            p_status: status,
            p_cost_per_call: cost_per_call,
            p_display_name: display_name,
            p_tags: tags
        });

        if (error) {
            console.error(`[Stats] RPC error [${paymentType}] for [${skillName}] user [${userUid.slice(-6)}]:`, error.message);
        } else {
            console.log(`[Stats] Recorded: [${paymentType}] skill=${skillName} cost=${cost} user=...${userUid.slice(-6)}`);
        }
    } catch (err) {
        console.error(`[Stats] Unexpected error recording call for ${skillName}:`, err);
    }
}
