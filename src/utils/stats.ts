import { createClient } from '@supabase/supabase-js';

// 🌟 核心定义：严格的三层业务状态类型 (Strict Tri-state Enum)
export type ExecutionTxStatus = {
    status_code: number;
    execution_status: 'SUCCESS' | 'FAILED' | 'SKIPPED';
    error_message: string | null;
    latency_ms: number;       // 🌟 耗时监测
    metadata: any;            // 🌟 诊断诊断 JSONB 信息
};

/**
 * Initialize Supabase client
 */
const getSupabaseClient = (env: any) => {
    // 逻辑：记账属于高权限后端操作，优先使用 SERVICE_ROLE_KEY 绕过 RLS 限制
    const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;
    return createClient(env.SUPABASE_URL, key);
};

/**
 * Records skill usage in Supabase using the integrated 'skills' table.
 * Supports dual-dimension statistics (credits/usd) and tri-state error logging.
 */
export async function recordSkillCall(
    env: any, 
    userUid: string,
    skillName: string, 
    requestId: string,
    credits: number = 0, 
    paymentType: 'credits' | 'usd' = 'credits', 
    txStatus: ExecutionTxStatus,  
    creditsPerCall?: number,
    display_name?: string, 
    tags?: string[],
    skillUid?: string | null     
): Promise<void> {
    const supabase = getSupabaseClient(env);
    const OFFICIAL_UUID = '00000000-0000-0000-0000-000000000001';
    
    // UUID Validator (Relaxed)
    const isValidId = (id: any) => typeof id === 'string' && id.length > 0;

    try {
        const rpcPayload = {
            p_user_uid: userUid,
            p_skill_name: skillName,
            p_source_skill_uid: skillUid || OFFICIAL_UUID, 
            p_payment_type: paymentType,
            p_request_id: requestId,
            p_cost: credits,
            
            p_status_code: txStatus.status_code,
            p_execution_status: txStatus.execution_status,
            p_error_message: txStatus.error_message,
            p_latency_ms: txStatus.latency_ms,
            p_metadata: { 
                ...txStatus.metadata,
                display_name: display_name,
                tags: tags
            }, 
            
            p_credits_per_call: creditsPerCall,
            p_display_name: display_name,
            p_tags: tags
        };

        console.log(`[Stats] Recording usage for ${skillName} (User: ${userUid.slice(-6)})...`);

        // 1. 直接尝试写入日志表 (Direct insert fallback)
        const { error: insertError } = await supabase
            .from('skill_usage_logs')
            .insert({
                user_uid: userUid,
                skill_name: skillName,
                request_id: requestId,
                status_code: txStatus.status_code,
                execution_status: txStatus.execution_status,
                latency_ms: txStatus.latency_ms,
                cost_credits: credits,
                metadata: rpcPayload.p_metadata
            });

        if (insertError) {
            console.error(`[Stats] Direct insert failed:`, insertError.message);
        }

        // 2. 调用 RPC (Legacy/Unified logic)
        const { error: rpcError } = await supabase.rpc('record_skill_usage', rpcPayload);

        if (rpcError) {
            console.error(`[Stats] RPC error:`, rpcError.message);
        } else {
            console.log(`[Stats] Successfully recorded: skill=${skillName} user=...${userUid.slice(-6)}`);
        }
    } catch (err) {
        console.error(`[Stats] Unexpected error recording call for ${skillName}:`, err);
    }
}
